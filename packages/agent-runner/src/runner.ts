import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { validateMaterializedWorkspace, validatePrivateBriefPath } from "./isolation.js";
import { parseAgentSummary, writeAgentOutputSchema } from "./schema.js";
import type {
  AgentExecutionResult,
  AgentRunOptions,
  AgentSummary,
  CodexEvent,
} from "./types.js";

const FIXED_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_MODEL = "gpt-5.6-sol";
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const MAX_SUMMARY_BYTES = 1024 * 1024;

export function buildAgentPrompt(options: AgentRunOptions): string {
  const brief = options.privateBriefPath ?? ".veil-private/brief.md";
  return [
    `You are ${options.role.name}. ${options.role.instruction}`,
    `Read the confidential brief at ${brief}. Implement the requested change without altering the public API unless the brief explicitly requires it.`,
    "Add focused regression coverage when useful and run the repository's supported validation scripts.",
    "Do not use Git, create commits, push, publish, or modify anything inside .veil-private.",
    "Never quote or copy confidential brief text, sentinels, credentials, or secrets into source, tests, logs, or your final response.",
    "Keep the change within your assigned role. Filesystem state and external verification are authoritative.",
  ].join("\n");
}

export function buildCodexArgs(options: AgentRunOptions, schemaPath: string, outputPath: string): string[] {
  return [
    "exec",
    "--model",
    options.model ?? DEFAULT_MODEL,
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    `shell_environment_policy.set={PATH="${FIXED_PATH}",LANG="C.UTF-8",LC_ALL="C.UTF-8"}`,
    "-C",
    options.workspaceDirectory,
    buildAgentPrompt(options),
  ];
}

export function minimalCodexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: FIXED_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  // Codex's ChatGPT authentication is stored beneath HOME. No token variables are inherited.
  if (source.HOME) environment.HOME = source.HOME;
  if (source.CODEX_HOME) environment.CODEX_HOME = source.CODEX_HOME;
  return environment;
}

function parseEvent(line: string): CodexEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const event = parsed as Record<string, unknown>;
    if (typeof event.type !== "string") return null;
    return event as CodexEvent;
  } catch {
    return null;
  }
}

export function parseCodexJsonl(jsonl: string): {
  events: CodexEvent[];
  threadId: string | null;
  malformedLineCount: number;
} {
  const events: CodexEvent[] = [];
  let threadId: string | null = null;
  let malformedLineCount = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    if (!event) {
      malformedLineCount += 1;
      continue;
    }
    events.push(event);
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      threadId = event.thread_id;
    }
  }
  return { events, threadId, malformedLineCount };
}

export async function runCodexAgent(options: AgentRunOptions): Promise<AgentExecutionResult> {
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60_000) {
    throw new Error("Agent timeout must be between one second and one hour");
  }
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "veil-codex-"));
  const runtimeDirectory = path.join(runRoot, "runtime");
  const startedAt = new Date().toISOString();
  const events: CodexEvent[] = [];
  let malformedLineCount = 0;
  let threadId: string | null = null;
  let stderr = "";
  let timedOut = false;
  let cancelled = false;
  let summary: AgentSummary | null = null;

  try {
    await mkdir(runtimeDirectory, { mode: 0o700 });
    const schemaPath = await writeAgentOutputSchema(runtimeDirectory);
    const outputPath = path.join(runtimeDirectory, "last-message.json");
    const workspaceDirectory = await validateMaterializedWorkspace(options.workspaceDirectory);
    validatePrivateBriefPath(options.privateBriefPath);
    const isolationRequired = options.isolationMode === "required";
    let invocation: { command: string; args: string[]; environment: NodeJS.ProcessEnv; cwd: string };
    if (isolationRequired) {
      throw new Error("Mount-isolated execution cannot access Codex-owned authentication without copying or mounting credentials; use the local disabled isolation mode until an OS-native credential boundary is available");
    } else {
      invocation = {
        command: options.codexBinary ?? "codex",
        args: buildCodexArgs(options, schemaPath, outputPath),
        environment: minimalCodexEnvironment(),
        cwd: workspaceDirectory,
      };
    }
    const child = spawn(
      invocation.command,
      invocation.args,
      {
        cwd: invocation.cwd,
        env: invocation.environment,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    let hardKill: NodeJS.Timeout | null = null;
    let terminationStarted = false;
    let lines: readline.Interface | null = null;
    const signalTree = (signal: NodeJS.Signals): void => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      } else child.kill(signal);
    };
    const terminate = (reason: "timeout" | "cancel" | "output-limit"): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      if (reason === "timeout") timedOut = true;
      else if (reason === "cancel") cancelled = true;
      else stderr += `${stderr ? "\n" : ""}Agent output exceeded the safe limit.`;
      if (reason === "output-limit") {
        // Stop readline from retaining an attacker-controlled unterminated line
        // and kill immediately; no graceful cleanup is trusted after flooding.
        lines?.close();
        child.stdout.pause();
        child.stdout.destroy();
        signalTree("SIGKILL");
        return;
      }
      signalTree("SIGTERM");
      hardKill = setTimeout(() => signalTree("SIGKILL"), 5_000);
      hardKill.unref();
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 256_000) stderr = stderr.slice(-256_000);
    });
    let stdoutBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) terminate("output-limit");
    });
    lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const event = parseEvent(line);
      if (!event) {
        malformedLineCount += 1;
        return;
      }
      if (events.length >= MAX_EVENTS) {
        terminate("output-limit");
        return;
      }
      events.push(event);
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
      }
      try {
        void Promise.resolve(options.onEvent?.(event)).catch(() => undefined);
      } catch { /* host callbacks cannot crash the runner */ }
    });
    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    timeout.unref();
    const abort = (): void => terminate("cancel");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const exitCode = await new Promise<number>((resolve) => {
      child.once("error", (error) => {
        stderr += `${stderr ? "\n" : ""}Agent process could not start: ${error.message}`;
        resolve(1);
      });
      child.once("close", (code) => resolve(code ?? 1));
    });
    clearTimeout(timeout);
    if (hardKill) clearTimeout(hardKill);
    options.signal?.removeEventListener("abort", abort);
    try {
      if ((await stat(outputPath)).size > MAX_SUMMARY_BYTES) throw new Error("Agent summary exceeds safe limit");
      summary = parseAgentSummary(JSON.parse(await readFile(outputPath, "utf8")));
    } catch {
      summary = null;
    }
    return {
      exitCode,
      startedAt,
      endedAt: new Date().toISOString(),
      threadId,
      summary,
      events,
      malformedLineCount,
      stderr,
      timedOut,
      cancelled,
    };
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}
