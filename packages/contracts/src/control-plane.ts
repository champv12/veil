export const controlPlaneChangeStates = [
  "PREFLIGHT", "IMPORTING", "ENCRYPTING", "PRIVATE_READY", "MATERIALIZING",
  "AGENTS_RUNNING", "CAPTURING", "DESTROYING", "EVALUATING", "REVIEW_READY",
  "PUBLISHING", "PUBLISHED", "FAILED", "CANCELLED",
] as const;

export type ControlPlaneChangeState = (typeof controlPlaneChangeStates)[number];
export type ControlPlaneGateStatus = "passed" | "failed" | "skipped";

export interface ControlPlanePreflightRequest { repositoryUrl: string; ref?: string }
export type ControlPlaneVerificationStatus = "ready" | "unchecked" | "unavailable" | "baseline-failed" | "sandbox-unavailable";
export interface ControlPlanePreflightResult {
  /** @deprecated Mirrors repository.importable for V1 clients. */
  supported: boolean;
  repositoryUrl: string;
  resolvedRef: string;
  baseCommit?: string;
  repository: { importable: boolean };
  verification: {
    status: ControlPlaneVerificationStatus;
    profile: string | null;
    recipeDigest: string | null;
    runtime: string | null;
  };
  /** @deprecated Use verification.profile/runtime. */
  runtime: string | null;
  /** @deprecated Package managers are profile-specific. */
  packageManager: string | null;
  checks: Array<{ name: string; status: ControlPlaneGateStatus; detail: string }>;
  warnings: string[];
}

export interface ControlPlanePrivateChange {
  id: string;
  /** Server-derived tenant ownership. Never accept this from a browser request. */
  tenantId: string;
  title: string;
  repositoryUrl: string;
  requestedRef: string;
  baseCommit?: string;
  status: ControlPlaneChangeState;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
  selectedCandidateId?: string;
  publishedBranch?: string;
  verification?: ControlPlanePreflightResult["verification"];
}

export interface ControlPlaneAgentSpec { instruction: string; model?: string }
export interface ControlPlanePublicationRecord {
  candidateId: string;
  mode?: "draft-pr" | "patch";
  branch: string;
  commit: string | null;
  patchSha256: string;
  draftPullRequestUrl?: string;
  patchArtifactId?: string;
  publishedAt: string;
}
export interface ControlPlaneRunRecord {
  id: string;
  /** Must match the tenant that owns `changeId`. */
  tenantId: string;
  changeId: string;
  status: ControlPlaneChangeState;
  agents: [ControlPlaneAgentSpec];
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  selectedCandidateId?: string;
  publication?: ControlPlanePublicationRecord;
  failure?: { code: string; message: string };
}
export interface ControlPlaneCandidateGate { name: string; status: ControlPlaneGateStatus; detail: string }
export interface ControlPlaneCandidateProvenance {
  protocolVersion: 1;
  eventId: string;
  eventObjectId: string;
  evaluationReceiptObjectId: string;
  source: "manual-capture" | "agent-final";
  actorType: "maintainer" | "codex";
  parentSnapshotId: string;
  resultSnapshotId: string;
  integrityMac: string;
  createdAt: string;
}
export interface ControlPlaneCandidateRecord {
  id: string;
  runId: string;
  changeId: string;
  label: string;
  summary: string;
  snapshotId: string;
  changedFiles: string[];
  insertions: number;
  deletions: number;
  gates: ControlPlaneCandidateGate[];
  verification?: { status: "verified" | "failed" | "unchecked" | "unavailable" | "isolation-unavailable"; profile: string | null; recipeDigest: string | null };
  knownRisks: string[];
  sanitizedDiff: string;
  patchSha256: string;
  provenance: ControlPlaneCandidateProvenance;
  createdAt: string;
}
export type ControlPlaneSafeArtifactKind = "redacted-report" | "sanitized-patch" | "evidence-summary";
export interface ControlPlaneArtifactRecord {
  id: string;
  runId: string;
  candidateId?: string;
  kind: ControlPlaneSafeArtifactKind;
  mediaType: "application/json" | "text/markdown" | "text/x-diff";
  sha256: string;
  content: string;
  createdAt: string;
}
export interface ControlPlaneAuditEvent {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  state: ControlPlaneChangeState;
  at: string;
  detail: string;
}
export interface ControlPlaneExecutionCandidate extends Omit<ControlPlaneCandidateRecord, "id" | "runId" | "changeId" | "createdAt"> {}
export interface ControlPlaneExecutionArtifact {
  candidateIndex?: number;
  kind: ControlPlaneSafeArtifactKind;
  mediaType: ControlPlaneArtifactRecord["mediaType"];
  sha256: string;
  content: string;
}
export interface ControlPlaneExecutionOutcome {
  baseCommit: string;
  candidates: ControlPlaneExecutionCandidate[];
  artifacts: ControlPlaneExecutionArtifact[];
}

export interface CreateControlPlaneChangeRequest { title: string; repositoryUrl: string; ref?: string }
export interface StartControlPlaneRunRequest {
  objective: string;
  model?: string;
}
export interface PublishControlPlaneCandidateRequest {
  confirm: true;
  mode?: "draft-pr" | "patch";
  branch?: string;
  createDraftPullRequest?: boolean;
  allowUnchecked?: boolean;
}
export interface ControlPlanePublicRunView extends Omit<ControlPlaneRunRecord, "agents" | "selectedCandidateId"> {
  harness: Record<string, never>;
  result?: Omit<ControlPlaneCandidateRecord, "sanitizedDiff">;
  artifactIds: string[];
  artifacts: Array<Omit<ControlPlaneArtifactRecord, "content">>;
}
