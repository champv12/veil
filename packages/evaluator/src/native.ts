import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { displayCommand, verificationRecipeDigest } from "./plan.js";
import { validateEvaluationTree } from "./filesystem.js";
import { materializePrivateEvaluatorSuite, type EncryptedPrivateEvaluatorSuite } from "./private-suite.js";
import type { EvaluationBackend, EvaluationResult, ResolvedToolchains, VerificationCommandSpec, VerificationGate, VerificationRecipeV2 } from "./types.js";

const MAX_OUTPUT = 128_000;
const SAFE_PATH_PARTS = [path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const SAFE_PATH = [...new Set(SAFE_PATH_PARTS)].join(path.delimiter);
const NODE_PREFIX = path.dirname(path.dirname(process.execPath));

interface ProcessResult { exitCode: number; output: string; durationMs: number; timedOut: boolean }

async function run(command: string, args: string[], options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  const started = Date.now();
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, { cwd: options.cwd, detached: process.platform !== "win32", env: options.env, stdio: ["ignore", "pipe", "pipe"], shell: false });
  } catch {
    return { exitCode: 1, output: "Verification process could not start.", durationMs: Date.now() - started, timedOut: false };
  }
  let output = "";
  let timedOut = false;
  const collect = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
    if (output.length > MAX_OUTPUT) output = `[output truncated]\n${output.slice(-MAX_OUTPUT)}`;
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let hardKill: NodeJS.Timeout | null = null;
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    } else child.kill(signal);
  };
  const terminate = (timeout: boolean): void => {
    if (stopping) return;
    stopping = true;
    timedOut = timeout;
    stop("SIGTERM");
    hardKill = setTimeout(() => stop("SIGKILL"), 5_000);
    hardKill.unref();
  };
  const abort = (): void => terminate(false);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => terminate(true), options.timeoutMs);
  timer.unref();
  try {
    const exitCode = await new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number): void => { if (!settled) { settled = true; resolve(code); } };
      child.once("error", () => { output += `${output ? "\n" : ""}Verification process could not start.`; finish(1); });
      child.once("close", (code, signal) => { if (signal) output += `\nProcess terminated by ${signal}.`; finish(code ?? 1); });
    });
    return { exitCode, output, durationMs: Date.now() - started, timedOut };
  } finally {
    clearTimeout(timer);
    if (hardKill) clearTimeout(hardKill);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function nativeSandboxBackend(): Promise<Extract<EvaluationBackend, "macos-sandbox" | "bubblewrap"> | null> {
  try {
    if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
      const result = await run("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"], { timeoutMs: 5_000, env: { PATH: SAFE_PATH } });
      return result.exitCode === 0 ? "macos-sandbox" : null;
    }
    if (process.platform === "linux") {
      const root = await mkdtemp(path.join(os.tmpdir(), "veil-bwrap-check-"));
      const workspace = path.join(root, "workspace");
      const home = path.join(root, "home");
      try {
        await Promise.all([mkdir(workspace), mkdir(home)]);
        const result = await run("bwrap", buildBubblewrapArgs({ workspace, home, argv: ["/usr/bin/true"], network: false }), { timeoutMs: 5_000, env: { PATH: SAFE_PATH } });
        return result.exitCode === 0 ? "bubblewrap" : null;
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  } catch { /* unavailable */ }
  return null;
}

export async function resolveToolchains(recipe: VerificationRecipeV2, repositoryRoot: string): Promise<ResolvedToolchains> {
  const searchParts = [...new Set([...(process.env.PATH ?? "").split(path.delimiter), ...SAFE_PATH_PARTS].filter(Boolean))];
  const executablePaths = new Map<string, string>();
  const runtimeRoots = new Set<string>([NODE_PREFIX]);
  const missing: string[] = [];
  for (const toolchain of recipe.toolchains) {
    let candidate: string | null = null;
    if (toolchain.executable.includes("/")) {
      const resolved = path.resolve(repositoryRoot, toolchain.executable);
      if ((resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${path.sep}`)) && existsSync(resolved)) candidate = resolved;
    } else {
      for (const directory of searchParts) {
        const resolved = path.join(directory, toolchain.executable);
        if (existsSync(resolved)) { candidate = resolved; break; }
      }
    }
    if (!candidate) { missing.push(toolchain.executable); continue; }
    const canonical = await realpath(candidate).catch(() => candidate!);
    executablePaths.set(toolchain.executable, candidate);
    if (!canonical.startsWith(`${repositoryRoot}${path.sep}`)) {
      runtimeRoots.add(path.dirname(candidate));
      runtimeRoots.add(path.dirname(canonical));
    }
  }
  const resolvedDirs = [...executablePaths.values()].map((entry) => path.dirname(entry));
  return { available: missing.length === 0, executablePaths, searchPath: [...new Set([...resolvedDirs, ...SAFE_PATH_PARTS])].join(path.delimiter), runtimeRoots: [...runtimeRoots], missing };
}

export function buildMacSandboxProfile(options: { workspace: string; home: string; privateSuiteDirectory?: string; network: boolean; workspaceReadOnly?: boolean; runtimeRoots?: string[] }): string {
  const evaluationRoot = path.dirname(options.workspace);
  const temporaryRoot = path.dirname(evaluationRoot);
  const readableEvaluationRoots = [evaluationRoot, NODE_PREFIX, ...(options.runtimeRoots ?? []), ...(options.privateSuiteDirectory ? [options.privateSuiteDirectory] : [])];
  const writableRoots = [options.home, ...(options.workspaceReadOnly ? [] : [options.workspace])];
  const exceptions = (roots: string[]) => [...new Set(roots)].map((root) => `(require-not (subpath ${JSON.stringify(root)}))`).join(" ");
  return [
    "(version 1)", "(allow default)", ...(options.network ? [] : ["(deny network*)"]),
    `(deny file-read* (require-all (subpath "/Users") ${exceptions(readableEvaluationRoots)}))`,
    `(deny file-read* (require-all (subpath "/Volumes") ${exceptions(readableEvaluationRoots)}))`,
    `(deny file-read* (require-all (subpath "/Network") ${exceptions(readableEvaluationRoots)}))`,
    `(deny file-read* (require-all (subpath "/home") ${exceptions(readableEvaluationRoots)}))`,
    `(deny file-read* (require-all (subpath "/private/var/root") ${exceptions(readableEvaluationRoots)}))`,
    `(deny file-read* (require-all (subpath "/var/root") ${exceptions(readableEvaluationRoots)}))`,
    `(deny file-read* (require-all (subpath ${JSON.stringify(temporaryRoot)}) (require-not (literal ${JSON.stringify(temporaryRoot)})) ${exceptions(readableEvaluationRoots)}))`,
    `(deny file-write* (require-all ${exceptions(writableRoots)}))`, "",
  ].join("\n");
}

export function buildBubblewrapArgs(options: { workspace: string; home: string; argv?: string[]; command?: string; network: boolean; privateSuiteDirectory?: string; workspaceReadOnly?: boolean; runtimeRoots?: string[]; searchPath?: string; workingDirectory?: string; environment?: Record<string, string> }): string[] {
  const roots = [...new Set(["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc", NODE_PREFIX, ...(options.runtimeRoots ?? [])].filter(existsSync))];
  const argv = options.argv ?? ["/bin/sh", "-lc", options.command ?? "true"];
  return [
    "--die-with-parent", "--new-session", "--unshare-all", ...(options.network ? ["--share-net"] : []),
    ...roots.flatMap((root) => ["--ro-bind", root, root]), "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/home", "--bind", options.home, "/home/veil", options.workspaceReadOnly ? "--ro-bind" : "--bind", options.workspace, "/workspace",
    ...(options.privateSuiteDirectory ? ["--ro-bind", options.privateSuiteDirectory, "/veil-private-evaluator"] : []),
    "--chdir", options.workingDirectory ? `/workspace/${options.workingDirectory}` : "/workspace", "--setenv", "HOME", "/home/veil", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", options.searchPath ?? SAFE_PATH, "--setenv", "CI", "1",
    ...Object.entries(options.environment ?? {}).flatMap(([name, value]) => ["--setenv", name, value]),
    ...argv,
  ];
}

async function runGate(options: {
  backend: "macos-sandbox" | "bubblewrap";
  spec: VerificationCommandSpec;
  workspace: string;
  home: string;
  toolchains: ResolvedToolchains;
  signal?: AbortSignal;
  visibility?: "public" | "private";
  privateSuiteDirectory?: string;
  workspaceReadOnly?: boolean;
}): Promise<VerificationGate> {
  options.signal?.throwIfAborted();
  const workingDirectory = resolveWorkingDirectory(options.workspace, options.spec.workingDirectory);
  const resolvedArgv = options.spec.argv.map((part, index) => {
    const substituted = substitute(part, options.backend === "bubblewrap" ? "/workspace" : options.workspace, options.backend === "bubblewrap" ? "/veil-private-evaluator" : options.privateSuiteDirectory);
    return index === 0 ? (options.toolchains.executablePaths.get(substituted) ?? substituted) : substituted;
  });
  const environment = Object.fromEntries(Object.entries(options.spec.environment ?? {}).map(([name, value]) => [name, substitute(value, options.backend === "bubblewrap" ? "/workspace" : options.workspace, options.backend === "bubblewrap" ? "/veil-private-evaluator" : options.privateSuiteDirectory)]));
  let result: ProcessResult;
  if (options.backend === "macos-sandbox") {
    const profilePath = path.join(options.home, `sandbox-${randomUUID()}.sb`);
    await writeFile(profilePath, buildMacSandboxProfile({ workspace: options.workspace, home: options.home, network: options.spec.network === "enabled", runtimeRoots: options.toolchains.runtimeRoots, ...(options.privateSuiteDirectory ? { privateSuiteDirectory: options.privateSuiteDirectory } : {}), ...(options.workspaceReadOnly ? { workspaceReadOnly: true } : {}) }), { mode: 0o600, flag: "wx" });
    try {
      result = await run("/usr/bin/sandbox-exec", ["-f", profilePath, ...resolvedArgv], {
        timeoutMs: options.spec.timeoutMs, cwd: workingDirectory,
        env: { PATH: options.toolchains.searchPath, HOME: options.home, TMPDIR: path.join(options.home, "tmp"), CI: "1", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...environment },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } finally { await rm(profilePath, { force: true }); }
  } else {
    const bwrapArgv = resolvedArgv.map((part, index) => index === 0 && part.startsWith(`${options.workspace}${path.sep}`) ? `/workspace/${path.relative(options.workspace, part)}` : part);
    result = await run("bwrap", buildBubblewrapArgs({ workspace: options.workspace, home: options.home, argv: bwrapArgv, network: options.spec.network === "enabled", runtimeRoots: options.toolchains.runtimeRoots, searchPath: options.toolchains.searchPath, environment, ...(options.spec.workingDirectory ? { workingDirectory: options.spec.workingDirectory } : {}), ...(options.privateSuiteDirectory ? { privateSuiteDirectory: options.privateSuiteDirectory } : {}), ...(options.workspaceReadOnly ? { workspaceReadOnly: true } : {}) }), { timeoutMs: options.spec.timeoutMs, env: { PATH: options.toolchains.searchPath }, ...(options.signal ? { signal: options.signal } : {}) });
  }
  return {
    name: options.spec.name, visibility: options.visibility ?? "public", command: options.visibility === "private" ? "" : displayCommand(options.spec),
    status: result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode, durationMs: result.durationMs,
    output: options.visibility === "private" ? "" : result.timedOut ? `${result.output}\nTimed out.` : result.output,
  };
}

export async function evaluateCandidateNative(options: {
  backend: "macos-sandbox" | "bubblewrap";
  candidateDirectory: string;
  recipe: VerificationRecipeV2;
  baselineDirectory?: string;
  timeoutMsPerGate?: number;
  signal?: AbortSignal;
  privateEvaluator?: { envelope: EncryptedPrivateEvaluatorSuite; key: Buffer };
}): Promise<EvaluationResult> {
  options.signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  const evaluationRoot = await mkdtemp(path.join(os.tmpdir(), "veil-evaluate-native-"));
  const workspace = path.join(evaluationRoot, "workspace");
  const home = path.join(evaluationRoot, "home");
  let resolvedWorkspace: string;
  let resolvedHome: string;
  try {
    await mkdir(path.join(home, "tmp"), { recursive: true, mode: 0o700 });
    const candidateRoot = await validateEvaluationTree(options.candidateDirectory, options.recipe.ephemeralPaths);
    await cp(candidateRoot, workspace, { recursive: true, filter: (source) => !isExcluded(candidateRoot, source, options.recipe.ephemeralPaths) });
    if (options.baselineDirectory) await restoreProtectedPaths(options.baselineDirectory, workspace, options.recipe.protectedPaths);
    await validateEvaluationTree(workspace);
    resolvedWorkspace = await realpath(workspace);
    resolvedHome = await realpath(home);
  } catch (error) {
    await rm(evaluationRoot, { recursive: true, force: true });
    throw error;
  }
  const toolchains = await resolveToolchains(options.recipe, resolvedWorkspace);
  if (!toolchains.available) {
    await rm(evaluationRoot, { recursive: true, force: true });
    return unavailableResult({ startedAt, status: "unavailable", profile: options.recipe.profile, recipeDigest: verificationRecipeDigest(options.recipe), backend: options.backend, isolationAvailable: true, runtime: "host toolchain unavailable", error: `Missing verification toolchain: ${toolchains.missing.join(", ")}` });
  }
  const errors: string[] = [];
  const setup: VerificationGate[] = [];
  const gates: VerificationGate[] = [];
  let privateSuiteDirectory: string | undefined;
  try {
    for (const spec of options.recipe.setup) {
      const gate = await runGate({ backend: options.backend, spec: options.timeoutMsPerGate ? { ...spec, timeoutMs: options.timeoutMsPerGate } : spec, workspace: resolvedWorkspace, home: resolvedHome, toolchains, ...(options.signal ? { signal: options.signal } : {}) });
      setup.push(gate);
      if (gate.status === "failed") errors.push(`${gate.name} failed`);
      if (gate.status === "failed" && spec.required) break;
    }
    const setupPassed = options.recipe.setup.every((spec) => !spec.required || setup.find((gate) => gate.name === spec.name)?.status === "passed");
    if (setupPassed) {
      for (const spec of options.recipe.gates) {
        if (options.signal?.aborted) break;
        const gate = await runGate({ backend: options.backend, spec: options.timeoutMsPerGate ? { ...spec, timeoutMs: options.timeoutMsPerGate } : spec, workspace: resolvedWorkspace, home: resolvedHome, toolchains, ...(options.signal ? { signal: options.signal } : {}) });
        gates.push(gate);
        if (gate.status === "failed") errors.push(`${gate.name} failed`);
      }
      if (options.privateEvaluator && !options.signal?.aborted) {
        privateSuiteDirectory = path.join(evaluationRoot, "private-evaluator");
        const privateSuite = await materializePrivateEvaluatorSuite({ envelope: options.privateEvaluator.envelope, key: options.privateEvaluator.key, directory: privateSuiteDirectory });
        for (const definition of privateSuite.gates) {
          const gate = await runGate({ backend: options.backend, spec: definition.command, workspace: resolvedWorkspace, home: resolvedHome, toolchains, privateSuiteDirectory, workspaceReadOnly: true, visibility: "private", ...(options.signal ? { signal: options.signal } : {}) });
          gates.push({ ...gate, name: definition.redactedName });
          if (gate.status === "failed") errors.push("Private evaluator gate failed");
        }
      }
    }
    const requiredPassed = options.recipe.gates.every((spec) => !spec.required || gates.find((gate) => gate.name === spec.name)?.status === "passed");
    const privatePassed = !options.privateEvaluator || options.privateEvaluator.envelope.gates.every(({ redactedName }) => gates.find((gate) => gate.name === redactedName)?.status === "passed");
    const passed = setupPassed && requiredPassed && privatePassed;
    return {
      passed, status: passed ? "verified" : "failed", profile: options.recipe.profile, recipeDigest: verificationRecipeDigest(options.recipe), startedAt, endedAt: new Date().toISOString(),
      backend: options.backend, isolationAvailable: true, runtime: `host ${options.recipe.profile}`, install: summarizeSetup(setup), setup, gates, errors,
    };
  } finally {
    if (privateSuiteDirectory) await rm(privateSuiteDirectory, { recursive: true, force: true });
    await rm(evaluationRoot, { recursive: true, force: true });
  }
}

/** Compatibility name retained during migration. */
export const evaluateNodeCandidateNative = evaluateCandidateNative;

export function summarizeSetup(setup: VerificationGate[]): VerificationGate {
  if (setup.length === 0) return { name: "setup", visibility: "public", command: "", status: "skipped", exitCode: null, durationMs: 0, output: "" };
  const failed = setup.find((gate) => gate.status === "failed");
  return { name: "setup", visibility: "public", command: setup.map((gate) => gate.command).join(" && "), status: failed ? "failed" : "passed", exitCode: failed?.exitCode ?? 0, durationMs: setup.reduce((sum, gate) => sum + gate.durationMs, 0), output: setup.map((gate) => gate.output).filter(Boolean).join("\n") };
}

export function unavailableResult(input: { startedAt: string; status: "unavailable" | "isolation-unavailable"; profile: string | null; recipeDigest: string | null; backend: EvaluationBackend; isolationAvailable: boolean; runtime: string; error: string }): EvaluationResult {
  const install = summarizeSetup([]);
  return { passed: false, status: input.status, profile: input.profile, recipeDigest: input.recipeDigest, startedAt: input.startedAt, endedAt: new Date().toISOString(), backend: input.backend, isolationAvailable: input.isolationAvailable, runtime: input.runtime, install, setup: [], gates: [], errors: [input.error] };
}

function resolveWorkingDirectory(workspace: string, relative: string | undefined): string {
  if (!relative) return workspace;
  const resolved = path.resolve(workspace, ...relative.split("/"));
  if (!resolved.startsWith(`${workspace}${path.sep}`)) throw new Error("Verification working directory escapes workspace");
  return resolved;
}

function substitute(value: string, candidateRoot: string, privateSuiteRoot?: string): string {
  return value.replaceAll("{{candidateRoot}}", candidateRoot).replaceAll("{{privateSuite}}", privateSuiteRoot ?? "");
}

function isExcluded(root: string, source: string, ephemeral: string[]): boolean {
  const relative = path.relative(root, source).split(path.sep).join("/");
  if (!relative) return false;
  const reserved = [".git", ".veil", ".veil-private", ".veil-state", ".veil-runs"];
  return [...reserved, ...ephemeral].some((entry) => relative === entry || relative.startsWith(`${entry}/`));
}

async function restoreProtectedPaths(baseline: string, workspace: string, protectedPaths: string[]): Promise<void> {
  for (const relative of protectedPaths) {
    const source = path.join(baseline, ...relative.split("/"));
    try { await lstat(source); } catch { continue; }
    const target = path.join(workspace, ...relative.split("/"));
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
}
