import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertGitObjectId, runCommand } from "./git.js";
import { createPatchAgainstDirectory } from "./publication.js";
import { safeRelativePath } from "./tree.js";

export type ReadOnlyGitContextRequest =
  | { operation: "base" }
  | { operation: "diff" }
  | { operation: "commits"; limit?: number }
  | { operation: "file-history"; path: string; limit?: number }
  | { operation: "blame"; path: string; startLine: number; endLine: number };

export interface ReadOnlyGitContextResult {
  baseCommit: string;
  operation: ReadOnlyGitContextRequest["operation"];
  output: string;
  truncated: false;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return result;
}

/**
 * A deliberately small read-only alternative to putting `.git`, Git config, hooks, remotes, or
 * credentials in an agent work view. Callers expose this result, never the repository directory.
 */
export async function readOnlyGitContext(options: {
  repositoryDirectory: string;
  /** Trusted host-selected private work view. This path is never accepted from the request. */
  candidateDirectory?: string;
  expectedBaseCommit: string;
  request: ReadOnlyGitContextRequest;
}): Promise<ReadOnlyGitContextResult> {
  const repositoryDirectory = await realpath(options.repositoryDirectory);
  const expectedBaseCommit = assertGitObjectId(options.expectedBaseCommit, "Expected base commit");
  const actualBase = assertGitObjectId((await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: repositoryDirectory, maxOutputBytes: 1024,
  })).stdout.trim());
  if (actualBase !== expectedBaseCommit) throw new Error("Git context source no longer matches the immutable base commit");
  let output = "";
  switch (options.request.operation) {
    case "base":
      output = expectedBaseCommit;
      break;
    case "diff": {
      if (!options.candidateDirectory) throw new Error("A host-selected candidate directory is required for a Git context diff");
      const candidateDirectory = await realpath(options.candidateDirectory);
      const temporary = await mkdtemp(path.join(os.tmpdir(), "veil-git-context-"));
      try {
        const preview = await createPatchAgainstDirectory({ baseDirectory: repositoryDirectory, candidateDirectory, workRoot: temporary });
        if (Buffer.byteLength(preview.patch) > 512 * 1024) throw new Error("Git context diff exceeds the 512 KiB disclosure limit");
        output = preview.patch;
      } finally { await rm(temporary, { recursive: true, force: true }); }
      break;
    }
    case "commits": {
      const limit = boundedInteger(options.request.limit, 10, 1, 50, "Commit limit");
      output = (await runCommand("git", ["--no-pager", "log", `-${limit}`, "--format=%H%x09%s", expectedBaseCommit], {
        cwd: repositoryDirectory, maxOutputBytes: 256 * 1024,
      })).stdout;
      break;
    }
    case "file-history": {
      const relative = safeRelativePath(options.request.path);
      const limit = boundedInteger(options.request.limit, 10, 1, 50, "Commit limit");
      output = (await runCommand("git", ["--no-pager", "log", `-${limit}`, "--format=%H%x09%s", expectedBaseCommit, "--", relative], {
        cwd: repositoryDirectory, maxOutputBytes: 256 * 1024,
      })).stdout;
      break;
    }
    case "blame": {
      const relative = safeRelativePath(options.request.path);
      const startLine = boundedInteger(options.request.startLine, 1, 1, 1_000_000, "Blame start line");
      const endLine = boundedInteger(options.request.endLine, startLine, startLine, startLine + 499, "Blame end line");
      output = (await runCommand("git", ["--no-pager", "blame", "--line-porcelain", `-L${startLine},${endLine}`, expectedBaseCommit, "--", relative], {
        cwd: repositoryDirectory, maxOutputBytes: 512 * 1024,
      })).stdout;
      break;
    }
  }
  return { baseCommit: expectedBaseCommit, operation: options.request.operation, output, truncated: false };
}
