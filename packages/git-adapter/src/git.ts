import { spawn } from "node:child_process";
import path from "node:path";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_DARWIN_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_POSIX_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function cleanEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: trustedGitPath(source.VEIL_GIT_PATH, platform),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (source.HOME) result.HOME = source.HOME;
  return result;
}

function trustedGitPath(configured: string | undefined, platform: NodeJS.Platform): string {
  const value = configured?.trim();
  if (!value) {
    if (platform === "win32") throw new Error("VEIL_GIT_PATH is required on Windows");
    return platform === "darwin" ? DEFAULT_DARWIN_PATH : DEFAULT_POSIX_PATH;
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  const entries = value.split(delimiter);
  if (entries.some((entry) => !entry || !pathApi.isAbsolute(entry))) {
    throw new Error("VEIL_GIT_PATH must contain only absolute directories");
  }
  return entries.join(delimiter);
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    stdin?: string;
    allowFailure?: boolean;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error("Git command resource limits are invalid");
  }
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? cleanEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    detached,
  });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let terminationReason: Error | undefined;
  const terminate = (reason: Error): void => {
    if (terminationReason) return;
    terminationReason = reason;
    if (child.pid && detached) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    } else child.kill("SIGKILL");
  };
  const append = (stream: "stdout" | "stderr", chunk: string): void => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > maxOutputBytes) {
      terminate(new Error(`${command} exceeded the ${maxOutputBytes}-byte output limit`));
      return;
    }
    if (stream === "stdout") stdout += chunk;
    else stderr += chunk;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => append("stdout", chunk));
  child.stderr.on("data", (chunk: string) => append("stderr", chunk));
  child.stdout.once("error", (error) => terminate(error));
  child.stderr.once("error", (error) => terminate(error));
  child.stdin.once("error", (error) => terminate(error));
  child.stdin.end(options.stdin);
  const timer = setTimeout(() => terminate(new Error(`${command} timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref();
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(timer));
  if (terminationReason) throw terminationReason;
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  }
  return { exitCode, stdout, stderr };
}

export interface ParsedGitHubRepository {
  owner: string;
  repository: string;
  cloneUrl: string;
  webUrl: string;
}

const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function assertGitObjectId(value: string, label = "Git object ID"): string {
  if (!GIT_OBJECT_ID.test(value)) throw new Error(`${label} must be a full lowercase SHA-1 or SHA-256 object ID`);
  return value;
}

/** Validate a ref before it is passed to Git as an argument. This intentionally accepts no refspec syntax. */
export function assertSafeGitRef(value: string, label = "Git ref"): string {
  if (
    value.length < 1 || value.length > 200 || value.startsWith("-") || value.startsWith("/")
    || value.endsWith("/") || value.endsWith(".") || value.includes("..") || value.includes("@{")
    || value.includes("//") || value === "@" || /[\u0000-\u0020\u007f~^:?*[\]\\]/.test(value)
    || value.split("/").some((component) => !component || component.startsWith(".") || component.endsWith(".lock"))
  ) throw new Error(`Unsafe ${label}`);
  return value;
}

export function assertSafePublicationBranch(value: string): string {
  assertSafeGitRef(value, "publication branch");
  if (!value.startsWith("veil/")) throw new Error("Publication branch must be a safe veil/* branch");
  return value;
}

export function parsePublicGitHubUrl(value: string): ParsedGitHubRepository {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Repository must be an HTTPS GitHub URL");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Veil supports canonical https://github.com repository URLs only");
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Repository URL must not contain credentials, a port, query, or fragment");
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Repository URL must have the form https://github.com/owner/repository");
  }
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  const safe = /^[A-Za-z0-9_.-]+$/;
  if (!safe.test(owner) || !safe.test(repository)) throw new Error("Invalid GitHub repository name");
  return {
    owner,
    repository,
    cloneUrl: `https://github.com/${owner}/${repository}.git`,
    webUrl: `https://github.com/${owner}/${repository}`,
  };
}

/** Normalize a local checkout's credential-free GitHub origin for storage and attestation. */
export function normalizeGitHubRemote(value: string): string {
  const trimmed = value.trim();
  const scp = /^git@github\.com:([^/]+)\/(.+)$/.exec(trimmed);
  if (scp) return parsePublicGitHubUrl(`https://github.com/${scp[1]}/${scp[2]}`).webUrl;
  const ssh = /^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/.exec(trimmed);
  if (ssh) return parsePublicGitHubUrl(`https://github.com/${ssh[1]}/${ssh[2]}`).webUrl;
  return parsePublicGitHubUrl(trimmed).webUrl;
}
