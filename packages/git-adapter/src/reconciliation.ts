import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeGitHubRemote, runCommand } from "./git.js";

export interface ObservedSourceState {
  version: 1;
  hashAlgorithm: "sha256";
  entries: Array<{
    path: string;
    kind: "file";
    executable: boolean;
    size: number;
    contentSha256: string;
  }>;
}

export interface LocalRepositoryObservation {
  repositoryUrl: string;
  headCommit: string;
  repositoryAnchorId: `sha256:${string}`;
  dirty: boolean;
  conflictedPaths: string[];
  statusDigest: `sha256:${string}`;
  /** Git-visible paths changed from the context's approved base. */
  changedPaths?: string[];
  /** Exact current Git-visible Source State, present when it differs from the approved base. */
  sourceState?: ObservedSourceState;
}

/**
 * Observe local Git state without fetching or accepting ambient repository
 * identity. The porcelain byte stream is hashed rather than persisted so
 * private paths never enter the Logical Change record.
 */
export async function observeLocalRepository(input: {
  cwd: string;
  expectedRepositoryUrl: string;
  expectedBaseCommit?: string;
}): Promise<LocalRepositoryObservation> {
  const expected = normalizeGitHubRemote(input.expectedRepositoryUrl);
  const origin = normalizeGitHubRemote((await runCommand("git", ["remote", "get-url", "origin"], { cwd: input.cwd })).stdout.trim());
  if (origin !== expected) throw new Error("Local repository origin no longer matches the Veil context");
  const headCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: input.cwd })).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(headCommit)) throw new Error("Local repository HEAD is invalid");
  const status = (await runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: input.cwd })).stdout;
  const conflicts = (await runCommand("git", ["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: input.cwd })).stdout;
  const conflictedPaths = conflicts.split("\0").filter(Boolean).sort();
  const statusDigest = `sha256:${createHash("sha256").update(status, "utf8").digest("hex")}` as const;
  const repositoryAnchorId = `sha256:${createHash("sha256")
    .update(expected, "utf8").update("\0")
    .update(headCommit, "utf8").update("\0")
    .update(statusDigest, "utf8")
    .digest("hex")}` as const;
  const expectedBaseCommit = input.expectedBaseCommit;
  if (expectedBaseCommit !== undefined && !/^[0-9a-f]{40,64}$/.test(expectedBaseCommit)) throw new Error("Expected repository base commit is invalid");
  const sourceChanged = status.length > 0 || (expectedBaseCommit !== undefined && headCommit !== expectedBaseCommit);
  const changedPaths = sourceChanged
    ? await observeChangedPaths(input.cwd, expectedBaseCommit ?? headCommit)
    : undefined;
  const sourceState = sourceChanged ? await observeSourceState(input.cwd) : undefined;
  const finalHead = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: input.cwd })).stdout.trim();
  const finalStatus = (await runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: input.cwd })).stdout;
  if (finalHead !== headCommit || finalStatus !== status) throw new Error("Local repository changed while Veil was observing its Source State");
  return {
    repositoryUrl: expected,
    headCommit,
    repositoryAnchorId,
    dirty: status.length > 0,
    conflictedPaths,
    statusDigest,
    ...(changedPaths === undefined ? {} : { changedPaths }),
    ...(sourceState === undefined ? {} : { sourceState }),
  };
}

/** Materialize only the exact Git-visible files authenticated by an observation. */
export async function materializeObservedSourceState(input: {
  sourceDirectory: string;
  targetDirectory: string;
  sourceState: ObservedSourceState;
}): Promise<void> {
  if ((await readdir(input.targetDirectory)).length !== 0) throw new Error("Observed Source State target must be empty");
  for (const entry of input.sourceState.entries) {
    const relative = assertSafeObservedPath(entry.path);
    const source = path.join(input.sourceDirectory, relative);
    const target = path.join(input.targetDirectory, relative);
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Observed Source State contains an unsupported entry: ${relative}`);
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const content = await handle.readFile();
      const digest = createHash("sha256").update(content).digest("hex");
      if (content.length !== entry.size || digest !== entry.contentSha256 || ((metadata.mode & 0o111) !== 0) !== entry.executable) {
        throw new Error(`Observed Source State changed before encrypted capture: ${relative}`);
      }
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: "wx", mode: entry.executable ? 0o755 : 0o644 });
      await chmod(target, entry.executable ? 0o755 : 0o644);
    } finally { await handle.close(); }
  }
}

async function observeChangedPaths(cwd: string, baseCommit: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runCommand("git", ["diff", "--name-only", "-z", "--no-renames", baseCommit, "--"], { cwd }),
    runCommand("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd }),
  ]);
  return [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")]
    .filter(Boolean)
    .map(assertSafeObservedPath))].sort();
}

async function observeSourceState(cwd: string): Promise<ObservedSourceState> {
  const listed = await runCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd });
  const entries: ObservedSourceState["entries"] = [];
  for (const relative of [...new Set(listed.stdout.split("\0").filter(Boolean).map(assertSafeObservedPath))].sort()) {
    const target = path.join(cwd, relative);
    let metadata;
    try { metadata = await lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Observed Source State contains an unsupported entry: ${relative}`);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const content = await handle.readFile();
      const final = await handle.stat();
      if (!final.isFile() || final.size !== metadata.size || final.mode !== metadata.mode) throw new Error(`Source file changed while Veil observed it: ${relative}`);
      entries.push({
        path: relative,
        kind: "file",
        executable: (final.mode & 0o111) !== 0,
        size: content.length,
        contentSha256: createHash("sha256").update(content).digest("hex"),
      });
    } finally { await handle.close(); }
  }
  return { version: 1, hashAlgorithm: "sha256", entries };
}

function assertSafeObservedPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Git returned an unsafe Source State path: ${JSON.stringify(value)}`);
  }
  if ([".git", ".veil", ".veil-private", ".veil-state", ".veil-runs"].includes(normalized.split("/")[0]!)) {
    throw new Error(`Git returned a reserved Source State path: ${normalized}`);
  }
  return normalized;
}
