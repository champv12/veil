export type VerificationGateStatus = "passed" | "failed" | "skipped";
export type VerificationStatus = "verified" | "failed" | "unchecked" | "unavailable" | "isolation-unavailable";

export interface VerificationGate {
  name: string;
  /** Private gates expose only a deliberately redacted label and pass/fail status. */
  visibility: "public" | "private";
  command: string;
  status: VerificationGateStatus;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface VerificationCommandSpec {
  name: string;
  argv: [string, ...string[]];
  workingDirectory?: string;
  environment?: Record<string, string>;
  network: "enabled" | "disabled";
  timeoutMs: number;
  required: boolean;
}

export interface VerificationRecipeV2 {
  version: 2;
  source: "detected" | "repository-config" | "user-config";
  profile: string;
  toolchains: Array<{ executable: string; versionArgs: string[] }>;
  setup: VerificationCommandSpec[];
  gates: VerificationCommandSpec[];
  container?: { image: string; user?: string };
  ephemeralPaths: string[];
  protectedPaths: string[];
}

/** @deprecated Use VerificationRecipeV2. */
export type VerificationPlan = VerificationRecipeV2;

export interface VerificationDetector {
  id: string;
  detect(baseDirectory: string): Promise<VerificationRecipeV2 | null>;
}

export type EvaluationBackend = "macos-sandbox" | "bubblewrap" | "docker" | "unavailable";

export interface EvaluationResult {
  passed: boolean;
  status: VerificationStatus;
  profile: string | null;
  recipeDigest: string | null;
  startedAt: string;
  endedAt: string;
  backend: EvaluationBackend;
  isolationAvailable: boolean;
  runtime: string;
  /** Compatibility summary for older API/UI consumers. */
  install: VerificationGate;
  setup: VerificationGate[];
  gates: VerificationGate[];
  errors: string[];
}

export interface ResolvedToolchains {
  available: boolean;
  executablePaths: Map<string, string>;
  searchPath: string;
  runtimeRoots: string[];
  missing: string[];
}
