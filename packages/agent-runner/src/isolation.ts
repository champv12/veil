import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentRunOptions } from "./types.js";

const RUNTIME_DIRECTORIES = ["/usr", "/bin", "/lib", "/lib64"];

/**
 * Verify that a materialized view cannot turn its single bind mount into a
 * capability to read elsewhere on the host. Snapshot materialization already
 * rejects links; this is deliberately repeated at the execution boundary.
 */
export async function validateMaterializedWorkspace(workspaceDirectory: string): Promise<string> {
  const requestedWorkspace = path.resolve(workspaceDirectory);
  const root = await lstat(requestedWorkspace);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("Agent workspace must be a real directory");
  }
  const workspace = await realpath(requestedWorkspace);
  const seen = new Map<string, string>();
  const inspect = async (directory: string, relativeDirectory = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const relative = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      const portable = relative.normalize("NFC").toLocaleLowerCase("en-US");
      const prior = seen.get(portable);
      if (prior !== undefined) throw new Error(`Agent workspace contains colliding paths: ${prior} and ${relative}`);
      seen.set(portable, relative);
      const status = await lstat(candidate);
      if (status.isSymbolicLink()) {
        throw new Error(`Agent workspace contains forbidden symbolic link: ${candidate}`);
      }
      if (status.isDirectory()) await inspect(candidate, relative);
      else if (!status.isFile()) {
        throw new Error(`Agent workspace contains forbidden special file: ${candidate}`);
      } else if (status.nlink !== 1) throw new Error(`Agent workspace contains forbidden hard-linked file: ${candidate}`);
    }
  };
  await inspect(workspace);
  return workspace;
}

export function validatePrivateBriefPath(privateBriefPath: string | undefined): void {
  const brief = privateBriefPath ?? ".veil-private/brief.md";
  if (path.isAbsolute(brief) || brief.split(path.sep).includes("..")) {
    throw new Error("Private brief path must stay inside the materialized workspace");
  }
}

export interface IsolatedCodexInvocation {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

export function buildBubblewrapArguments(input: {
  codexArgs: string[];
  workspaceDirectory: string;
  runRoot: string;
  codexBinary: string;
}): string[] {
  const { codexArgs, workspaceDirectory, runRoot, codexBinary } = input;
  return [
    "--die-with-parent",
    "--new-session",
    // Keep the Codex control-plane connection available. Commands launched by
    // Codex remain network-denied by its workspace-write sandbox configuration.
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--tmpfs", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--dir", "/workspace",
    "--bind", workspaceDirectory, "/workspace",
    "--dir", "/run",
    "--bind", runRoot, "/run",
    "--dir", "/opt/veil-runtime",
    "--ro-bind", codexBinary, "/opt/veil-runtime/codex",
  ];
}

/**
 * Construct a bubblewrap command with a tmpfs root. In particular, never bind
 * the host root, the host home, a Veil run root, or a parent workspace. The
 * only writable host binds are the validated materialized workspace and the
 * runner-owned output directory.
 */
export function buildMountIsolatedCodexInvocation(input: {
  options: AgentRunOptions;
  codexArgs: string[];
  workspaceDirectory: string;
  runRoot: string;
  codexBinary: string;
  environment: NodeJS.ProcessEnv;
}): IsolatedCodexInvocation {
  const { options, codexArgs, workspaceDirectory, runRoot, codexBinary, environment } = input;
  if (process.platform !== "linux") {
    throw new Error("Mount-isolated Codex execution requires Linux bubblewrap; refusing an unenclosed fallback");
  }
  if (!path.isAbsolute(workspaceDirectory) || !path.isAbsolute(runRoot) || !path.isAbsolute(codexBinary)) {
    throw new Error("Mount-isolated execution requires absolute host paths");
  }
  const args = buildBubblewrapArguments({ codexArgs, workspaceDirectory, runRoot, codexBinary });
  for (const runtimeDirectory of RUNTIME_DIRECTORIES) {
    args.push("--dir", runtimeDirectory);
    args.push("--ro-bind-try", runtimeDirectory, runtimeDirectory);
  }
  args.push("--chdir", "/workspace", "--", "/opt/veil-runtime/codex", ...codexArgs);
  return {
    command: options.isolationBinary ?? "bwrap",
    args,
    environment,
  };
}
