import { dockerAvailable, evaluateCandidateWithDocker } from "./docker.js";
import { evaluateCandidateNative, nativeSandboxBackend, resolveToolchains, unavailableResult } from "./native.js";
import { createNodeVerificationPlan, verificationRecipeDigest } from "./plan.js";
import type { EncryptedPrivateEvaluatorSuite } from "./private-suite.js";
import type { EvaluationBackend, EvaluationResult, VerificationRecipeV2 } from "./types.js";

export interface EvaluateCandidateOptions {
  candidateDirectory: string;
  recipe: VerificationRecipeV2 | null;
  baselineDirectory?: string;
  timeoutMsPerGate?: number;
  signal?: AbortSignal;
  privateEvaluator?: { envelope: EncryptedPrivateEvaluatorSuite; key: Buffer };
  backend?: Exclude<EvaluationBackend, "unavailable">;
}

/** @deprecated Use EvaluateCandidateOptions. */
export type EvaluateNodeCandidateOptions = Omit<EvaluateCandidateOptions, "recipe"> & { recipe?: VerificationRecipeV2 | null; plan?: VerificationRecipeV2 };

export async function availableVerificationBackend(): Promise<Exclude<EvaluationBackend, "unavailable"> | null> {
  const native = await nativeSandboxBackend();
  if (native) return native;
  return await dockerAvailable() ? "docker" : null;
}

export async function evaluateCandidate(options: EvaluateCandidateOptions): Promise<EvaluationResult> {
  const startedAt = new Date().toISOString();
  if (!options.recipe) {
    const empty = unavailableResult({ startedAt, status: "unavailable", profile: null, recipeDigest: null, backend: "unavailable", isolationAvailable: false, runtime: "not configured", error: "No verification recipe was detected or configured." });
    return { ...empty, status: "unchecked" };
  }
  const requested = options.backend;
  if (requested === "docker") return evaluateCandidateWithDocker({ ...options, recipe: options.recipe });
  const native = requested === "macos-sandbox" || requested === "bubblewrap" ? requested : await nativeSandboxBackend();
  if (native) {
    const toolchains = await resolveToolchains(options.recipe, options.candidateDirectory);
    if (toolchains.available) return evaluateCandidateNative({ ...options, recipe: options.recipe, backend: native });
    if (options.recipe.container && await dockerAvailable()) return evaluateCandidateWithDocker({ ...options, recipe: options.recipe });
    return unavailableResult({ startedAt, status: "unavailable", profile: options.recipe.profile, recipeDigest: verificationRecipeDigest(options.recipe), backend: native, isolationAvailable: true, runtime: "toolchain unavailable", error: `Missing verification toolchain: ${toolchains.missing.join(", ")}` });
  }
  if (options.recipe.container && await dockerAvailable()) return evaluateCandidateWithDocker({ ...options, recipe: options.recipe });
  return unavailableResult({ startedAt, status: "isolation-unavailable", profile: options.recipe.profile, recipeDigest: verificationRecipeDigest(options.recipe), backend: "unavailable", isolationAvailable: false, runtime: "unavailable", error: "No supported local verification sandbox is available." });
}

/** Compatibility wrapper retained while callers migrate to evaluateCandidate. */
export async function evaluateNodeCandidate(options: EvaluateNodeCandidateOptions): Promise<EvaluationResult> {
  return evaluateCandidate({ ...options, recipe: options.recipe ?? options.plan ?? await createNodeVerificationPlan(options.candidateDirectory) });
}
