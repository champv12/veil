import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { displayCommand, verificationRecipeDigest } from "./plan.js";
import { validateEvaluationTree } from "./filesystem.js";
import { materializePrivateEvaluatorSuite, type EncryptedPrivateEvaluatorSuite } from "./private-suite.js";
import { summarizeSetup, unavailableResult } from "./native.js";
import type { EvaluationResult, VerificationCommandSpec, VerificationGate, VerificationRecipeV2 } from "./types.js";

const MAX_OUTPUT = 128_000;

interface ProcessResult { exitCode: number; output: string; durationMs: number; timedOut: boolean }

async function run(command: string, args: string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  const started = Date.now();
  const child = spawn(command, args, { env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"], shell: false });
  let output = "";
  let timedOut = false;
  const collect = (chunk: Buffer): void => { output += chunk.toString("utf8"); if (output.length > MAX_OUTPUT) output = `[output truncated]\n${output.slice(-MAX_OUTPUT)}`; };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  let hardKill: NodeJS.Timeout | null = null;
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    hardKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    hardKill.unref();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs); timer.unref();
  try {
    const exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); });
    return { exitCode, output, durationMs: Date.now() - started, timedOut };
  } finally { clearTimeout(timer); if (hardKill) clearTimeout(hardKill); options.signal?.removeEventListener("abort", stop); }
}

export async function dockerAvailable(): Promise<boolean> {
  try { return (await run("docker", ["info", "--format", "{{json .ServerVersion}}"], { timeoutMs: 10_000 })).exitCode === 0; } catch { return false; }
}

export function buildDockerArgs(options: {
  image: string;
  workspace: string;
  argv?: string[];
  command?: string;
  network: "bridge" | "none";
  user?: string;
  containerName?: string;
  privateSuiteDirectory?: string;
  workspaceReadOnly?: boolean;
  workingDirectory?: string;
  environment?: Record<string, string>;
}): string[] {
  const argv = options.argv ?? ["sh", "-lc", options.command ?? "true"];
  return [
    "run", "--rm", ...(options.containerName ? ["--name", options.containerName] : []), "--init", "--network", options.network,
    "--cpus", "2", "--memory", "1g", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", options.user ?? hostContainerUser(), "--env", "HOME=/tmp", "--env", "CI=1", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
    ...Object.entries(options.environment ?? {}).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    "--mount", `type=bind,source=${options.workspace},target=/workspace${options.workspaceReadOnly ? ",readonly" : ""}`,
    ...(options.privateSuiteDirectory ? ["--mount", `type=bind,source=${options.privateSuiteDirectory},target=/veil-private-evaluator,readonly`] : []),
    "--workdir", options.workingDirectory ? `/workspace/${options.workingDirectory}` : "/workspace", "--entrypoint", "", options.image, ...argv,
  ];
}

function hostContainerUser(): string {
  const uid = process.getuid?.(); const gid = process.getgid?.();
  return uid === undefined || gid === undefined || uid === 0 ? "65534:65534" : `${uid}:${gid}`;
}

async function runGate(options: {
  spec: VerificationCommandSpec;
  recipe: VerificationRecipeV2;
  workspace: string;
  signal?: AbortSignal;
  visibility?: "public" | "private";
  privateSuiteDirectory?: string;
  workspaceReadOnly?: boolean;
}): Promise<VerificationGate> {
  options.signal?.throwIfAborted();
  const containerName = `veil-eval-${randomUUID()}`;
  const argv = options.spec.argv.map((part) => substitute(part));
  const environment = Object.fromEntries(Object.entries(options.spec.environment ?? {}).map(([name, value]) => [name, substitute(value)]));
  const result = await run("docker", buildDockerArgs({
    image: options.recipe.container!.image, workspace: options.workspace, argv,
    network: options.spec.network === "enabled" ? "bridge" : "none", user: options.recipe.container?.user ?? hostContainerUser(), containerName,
    ...(options.spec.workingDirectory ? { workingDirectory: options.spec.workingDirectory } : {}), ...(Object.keys(environment).length ? { environment } : {}),
    ...(options.privateSuiteDirectory ? { privateSuiteDirectory: options.privateSuiteDirectory } : {}), ...(options.workspaceReadOnly ? { workspaceReadOnly: true } : {}),
  }), { timeoutMs: options.spec.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
  if (result.timedOut || options.signal?.aborted) await run("docker", ["rm", "-f", containerName], { timeoutMs: 15_000 }).catch(() => undefined);
  return {
    name: options.spec.name, visibility: options.visibility ?? "public", command: options.visibility === "private" ? "" : displayCommand(options.spec),
    status: result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode, durationMs: result.durationMs,
    output: options.visibility === "private" ? "" : result.timedOut ? `${result.output}\nTimed out.` : result.output,
  };
}

export async function evaluateCandidateWithDocker(options: {
  candidateDirectory: string;
  recipe: VerificationRecipeV2;
  baselineDirectory?: string;
  timeoutMsPerGate?: number;
  signal?: AbortSignal;
  privateEvaluator?: { envelope: EncryptedPrivateEvaluatorSuite; key: Buffer };
}): Promise<EvaluationResult> {
  options.signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  if (!options.recipe.container) return unavailableResult({ startedAt, status: "unavailable", profile: options.recipe.profile, recipeDigest: verificationRecipeDigest(options.recipe), backend: "docker", isolationAvailable: true, runtime: "Docker recipe unavailable", error: "Verification recipe does not define a container image." });
  if (!(await dockerAvailable())) return unavailableResult({ startedAt, status: "isolation-unavailable", profile: options.recipe.profile, recipeDigest: verificationRecipeDigest(options.recipe), backend: "unavailable", isolationAvailable: false, runtime: "Docker unavailable", error: "Docker is unavailable." });
  const evaluationRoot = await mkdtemp(path.join(os.tmpdir(), "veil-evaluate-docker-"));
  const workspace = path.join(evaluationRoot, "workspace");
  try {
    const candidateRoot = await validateEvaluationTree(options.candidateDirectory, options.recipe.ephemeralPaths);
    await cp(candidateRoot, workspace, { recursive: true, filter: (source) => !isExcluded(candidateRoot, source, options.recipe.ephemeralPaths) });
    if (options.baselineDirectory) await restoreProtectedPaths(options.baselineDirectory, workspace, options.recipe.protectedPaths);
    await validateEvaluationTree(workspace);
  } catch (error) {
    await rm(evaluationRoot, { recursive: true, force: true });
    throw error;
  }
  const errors: string[] = [];
  const setup: VerificationGate[] = [];
  const gates: VerificationGate[] = [];
  let privateSuiteDirectory: string | undefined;
  try {
    for (const spec of options.recipe.setup) {
      const gate = await runGate({ spec: options.timeoutMsPerGate ? { ...spec, timeoutMs: options.timeoutMsPerGate } : spec, recipe: options.recipe, workspace, ...(options.signal ? { signal: options.signal } : {}) });
      setup.push(gate); if (gate.status === "failed") errors.push(`${gate.name} failed`); if (gate.status === "failed" && spec.required) break;
    }
    const setupPassed = options.recipe.setup.every((spec) => !spec.required || setup.find((gate) => gate.name === spec.name)?.status === "passed");
    if (setupPassed) {
      for (const spec of options.recipe.gates) {
        const gate = await runGate({ spec: options.timeoutMsPerGate ? { ...spec, timeoutMs: options.timeoutMsPerGate } : spec, recipe: options.recipe, workspace, ...(options.signal ? { signal: options.signal } : {}) });
        gates.push(gate); if (gate.status === "failed") errors.push(`${gate.name} failed`);
      }
      if (options.privateEvaluator && !options.signal?.aborted) {
        privateSuiteDirectory = path.join(evaluationRoot, "private-evaluator");
        const suite = await materializePrivateEvaluatorSuite({ envelope: options.privateEvaluator.envelope, key: options.privateEvaluator.key, directory: privateSuiteDirectory });
        for (const definition of suite.gates) {
          const gate = await runGate({ spec: definition.command, recipe: options.recipe, workspace, privateSuiteDirectory, workspaceReadOnly: true, visibility: "private", ...(options.signal ? { signal: options.signal } : {}) });
          gates.push({ ...gate, name: definition.redactedName }); if (gate.status === "failed") errors.push("Private evaluator gate failed");
        }
      }
    }
    const requiredPassed = options.recipe.gates.every((spec) => !spec.required || gates.find((gate) => gate.name === spec.name)?.status === "passed");
    const privatePassed = !options.privateEvaluator || options.privateEvaluator.envelope.gates.every(({ redactedName }) => gates.find((gate) => gate.name === redactedName)?.status === "passed");
    const passed = setupPassed && requiredPassed && privatePassed;
    return { passed, status: passed ? "verified" : "failed", profile: options.recipe.profile, recipeDigest: verificationRecipeDigest(options.recipe), startedAt, endedAt: new Date().toISOString(), backend: "docker", isolationAvailable: true, runtime: options.recipe.container.image, install: summarizeSetup(setup), setup, gates, errors };
  } finally {
    if (privateSuiteDirectory) await rm(privateSuiteDirectory, { recursive: true, force: true });
    await rm(evaluationRoot, { recursive: true, force: true });
  }
}

/** Compatibility name retained during migration. */
export const evaluateNodeCandidateWithDocker = evaluateCandidateWithDocker;

function substitute(value: string): string { return value.replaceAll("{{candidateRoot}}", "/workspace").replaceAll("{{privateSuite}}", "/veil-private-evaluator"); }

function isExcluded(root: string, source: string, ephemeral: string[]): boolean {
  const relative = path.relative(root, source).split(path.sep).join("/");
  if (!relative) return false;
  return [".git", ".veil", ".veil-private", ".veil-state", ".veil-runs", ...ephemeral].some((entry) => relative === entry || relative.startsWith(`${entry}/`));
}

async function restoreProtectedPaths(baseline: string, workspace: string, protectedPaths: string[]): Promise<void> {
  for (const relative of protectedPaths) {
    const source = path.join(baseline, ...relative.split("/"));
    try { await lstat(source); } catch { continue; }
    const target = path.join(workspace, ...relative.split("/"));
    await rm(target, { recursive: true, force: true }); await mkdir(path.dirname(target), { recursive: true }); await cp(source, target, { recursive: true });
  }
}
