import { chmod, copyFile, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./git.js";

/** `.veil` is a local context locator and cannot enter a patch or publication. */
export const DEFAULT_EXCLUDED_TOP_LEVEL = new Set([".git", ".veil", ".veil-private", ".veil-state", ".veil-runs"]);

export function safeRelativePath(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new Error(`Unsafe repository path: ${relativePath}`);
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== relativePath) {
    throw new Error(`Unsafe repository path: ${relativePath}`);
  }
  return normalized;
}

export function resolveInside(root: string, relativePath: string): string {
  const safe = safeRelativePath(relativePath);
  const target = path.resolve(root, ...safe.split("/"));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix)) throw new Error(`Path escapes repository: ${relativePath}`);
  return target;
}

export async function copySanitizedTree(source: string, target: string): Promise<string[]> {
  const paths: string[] = [];
  await mkdir(target, { recursive: true, mode: 0o700 });
  const visit = async (relativeDirectory: string): Promise<void> => {
    const directory = relativeDirectory ? resolveInside(source, relativeDirectory) : source;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (!relativeDirectory && DEFAULT_EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
      const relative = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      const sourcePath = resolveInside(source, relative);
      const targetPath = resolveInside(target, relative);
      const stat = await lstat(sourcePath);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are unsupported in V1: ${relative}`);
      if (stat.isDirectory()) {
        await mkdir(targetPath, { recursive: true, mode: stat.mode & 0o777 });
        await visit(relative);
      } else if (stat.isFile()) {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await copyFile(sourcePath, targetPath, 0);
        await chmod(targetPath, stat.mode & 0o777);
        paths.push(relative);
      } else {
        throw new Error(`Special files are unsupported in V1: ${relative}`);
      }
    }
  };
  await visit("");
  return paths;
}

/**
 * Export only files tracked by the immutable local Git index. Ignored credentials and other
 * ambient files are deliberately excluded even when the source checkout is clean.
 */
export async function copyTrackedTree(source: string, target: string): Promise<string[]> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const listed = await runCommand("git", ["ls-files", "-z", "--stage"], { cwd: source });
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const record of listed.stdout.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Git returned an invalid tracked-file record");
    const metadata = record.slice(0, separator).split(" ");
    const relative = safeRelativePath(record.slice(separator + 1));
    const mode = metadata[0];
    const stage = metadata[2];
    if (stage !== "0") throw new Error(`Local repository has an unresolved index entry: ${relative}`);
    if (relative === ".veil" || relative.startsWith(".veil/")) throw new Error("Veil reserves the top-level .veil directory");
    if (mode === "120000") throw new Error(`Symbolic links are unsupported in V1: ${relative}`);
    if (mode === "160000") throw new Error(`Git submodules are unsupported in V1: ${relative}`);
    if (mode !== "100644" && mode !== "100755") throw new Error(`Unsupported tracked Git mode ${mode}: ${relative}`);
    if (seen.has(relative)) continue;
    seen.add(relative);
    const sourcePath = resolveInside(source, relative);
    const targetPath = resolveInside(target, relative);
    const stat = await lstat(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Tracked path is not a regular file: ${relative}`);
    await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    await copyFile(sourcePath, targetPath, 0);
    await chmod(targetPath, mode === "100755" ? 0o755 : 0o644);
    paths.push(relative);
  }
  return paths.sort();
}

export async function clearExceptGit(root: string): Promise<void> {
  for (const entry of await readdir(root)) {
    if (entry === ".git") continue;
    await rm(path.join(root, entry), { recursive: true, force: true });
  }
}

export async function assertNoPrivateContent(root: string, forbiddenValues: string[] = []): Promise<void> {
  const visit = async (relativeDirectory: string): Promise<void> => {
    const directory = relativeDirectory ? resolveInside(root, relativeDirectory) : root;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!relativeDirectory && entry.name === ".git") continue;
      if (!relativeDirectory && [".veil", ".veil-private", ".veil-state"].includes(entry.name)) {
        throw new Error(`Forbidden private path: ${entry.name}`);
      }
      const relative = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      const target = resolveInside(root, relative);
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`Unsupported publication entry: ${relative}`);
      }
      if (stat.isDirectory()) await visit(relative);
      else {
        const bytes = await readFile(target);
        if (forbiddenValues.some((value) => value && bytes.includes(Buffer.from(value, "utf8")))) {
          throw new Error(`Forbidden confidential value found in ${relative}`);
        }
      }
    }
  };
  await visit("");
}
