export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Capability = "read" | "modify" | "review" | "publish";

export enum ChangeState {
  Preflight = "PREFLIGHT",
  Importing = "IMPORTING",
  Encrypting = "ENCRYPTING",
  PrivateReady = "PRIVATE_READY",
  Materializing = "MATERIALIZING",
  AgentsRunning = "AGENTS_RUNNING",
  Capturing = "CAPTURING",
  Destroying = "DESTROYING",
  Evaluating = "EVALUATING",
  ReviewReady = "REVIEW_READY",
  Publishing = "PUBLISHING",
  Published = "PUBLISHED",
  Failed = "FAILED",
  Cancelled = "CANCELLED",
}

export type SnapshotReason =
  | "import"
  | "agent_file_change"
  | "agent_final"
  | "manual"
  | "recovered";

export type ExecutionStatus =
  | "queued"
  | "running"
  | "capturing"
  | "destroyed"
  | "evaluating"
  | "completed"
  | "failed"
  | "cancelled";

export type PublicationMode = "draft_pull_request" | "git_patch";

export interface BaseReference {
  repositoryUrl: string;
  owner: string;
  repository: string;
  defaultBranch: string;
  baseCommit: string;
  importedAt: string;
}

export interface PrivateChange {
  id: string;
  title: string;
  description: string;
  base: BaseReference;
  ownerIdentityId: string;
  state: ChangeState;
  rootSnapshotId: string | null;
  selectedCandidateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotRecord {
  id: string;
  changeId: string;
  parentSnapshotId: string | null;
  actorIdentityId: string;
  encryptedManifestObjectId: string;
  evidenceObjectIds: string[];
  reason: SnapshotReason;
  eventSequence: number;
  treeHash: string;
  createdAt: string;
  /** HMAC-SHA256 over every other header field using a change-derived key. */
  headerMac: string;
}

export interface ValidationSummary {
  passed: boolean;
  scripts: Array<{
    name: string;
    passed: boolean;
    exitCode: number | null;
    durationMs: number;
  }>;
  changedFiles: string[];
  insertions: number;
  deletions: number;
  patchSha256: string | null;
  errors: string[];
}

export interface ExecutionView {
  id: string;
  changeId: string;
  agentIdentityId: string;
  status: ExecutionStatus;
  inputSnapshotId: string;
  outputSnapshotId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  summary: string | null;
}

export interface Candidate {
  id: string;
  changeId: string;
  executionId: string;
  snapshotId: string;
  label: string;
  validation: ValidationSummary | null;
  selected: boolean;
  createdAt: string;
}

export type AuditEventType =
  | "change.created"
  | "change.transitioned"
  | "identity.created"
  | "grant.created"
  | "snapshot.captured"
  | "snapshot.materialized"
  | "execution.started"
  | "execution.finished"
  | "candidate.evaluated"
  | "candidate.selected"
  | "publication.started"
  | "publication.completed"
  | "cleanup.completed"
  | "operation.failed";

export interface AuditEvent {
  id: string;
  changeId: string;
  sequence: number;
  type: AuditEventType;
  actorIdentityId: string | null;
  occurredAt: string;
  details: JsonValue;
  previousHash: string | null;
  hash: string;
}

export interface PublicationPolicy {
  mode: PublicationMode;
  branchName: string;
  requireExplicitConfirmation: boolean;
  openAsDraft: boolean;
  stripPrivatePaths: string[];
  requirePassingVerification: boolean;
}

export interface PreflightRequest {
  repositoryUrl: string;
}

export interface PreflightResponse {
  ok: boolean;
  repository: Pick<BaseReference, "owner" | "repository" | "defaultBranch"> | null;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

export interface CreateChangeRequest {
  title: string;
  description: string;
  base: BaseReference;
}

export interface CreateChangeResponse {
  change: PrivateChange;
}

export interface StartRunRequest {
  instructions: string;
}

export interface StartRunResponse {
  runId: string;
  executions: [ExecutionView];
}

export interface SelectCandidateRequest {
  candidateId: string;
}

export interface SelectCandidateResponse {
  change: PrivateChange;
  candidate: Candidate;
}

export interface PublishCandidateRequest {
  policy: PublicationPolicy;
  confirmed: boolean;
}

export interface PublishCandidateResponse {
  mode: PublicationMode;
  branchName: string;
  commitSha: string | null;
  pullRequestUrl: string | null;
  patchArtifactId: string | null;
}

export interface ApiError {
  code: string;
  message: string;
  details?: JsonValue;
}

export interface ArtifactDescriptor {
  id: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  downloadName: string;
}

export interface ListChangesResponse {
  changes: PrivateChange[];
}

export interface ChangeDetailResponse {
  change: PrivateChange;
  executions: ExecutionView[];
  candidates: Candidate[];
}

export interface GetRunResponse {
  runId: string;
  changeId: string;
  status: ExecutionStatus;
  executions: [ExecutionView];
  candidates: [Candidate];
}

export type RunEventType =
  | "state"
  | "agent_started"
  | "agent_progress"
  | "snapshot_captured"
  | "agent_finished"
  | "evaluation_finished"
  | "run_finished"
  | "run_failed";

export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  type: RunEventType;
  occurredAt: string;
  data: JsonValue;
}

export interface CancelRunResponse {
  runId: string;
  accepted: boolean;
  state: ChangeState;
}

export interface CandidateDiffResponse {
  candidateId: string;
  baseCommit: string;
  changedFiles: string[];
  insertions: number;
  deletions: number;
  patchSha256: string;
  patchArtifact: ArtifactDescriptor;
}

export interface GetArtifactResponse {
  artifact: ArtifactDescriptor;
}

export type AttestedGateStatus = "passed" | "failed" | "skipped" | "unavailable";

/** Public, bounded outcome metadata. Raw private gate output must never be included. */
export interface AttestedGateOutcome {
  name: string;
  status: AttestedGateStatus;
  evidenceSha256: string | null;
}

export interface PublicationIntentBinding {
  intentId: string;
  mode: PublicationMode;
  branchName: string | null;
  expiresAt: string;
}

/** Durable evidence that the authorized intent was consumed before expiry. */
export interface PublicationReceiptBinding {
  publishedAt: string;
  commitSha: string | null;
  draftPullRequestUrl: string | null;
}

/** The exact reviewed object and authorization that a Veil signature vouches for. */
export interface ExactResultAttestationPayload {
  version: 1;
  attestationId: string;
  issuer: string;
  issuedAt: string;
  repositoryUrl: string;
  baseCommit: string;
  patchSha256: string;
  recipeSha256: string | null;
  toolVersion: string;
  gates: AttestedGateOutcome[];
  publicationIntent: PublicationIntentBinding;
  publicationReceipt?: PublicationReceiptBinding;
}

export interface SignedExactResultAttestation {
  version: 1;
  algorithm: "Ed25519";
  keyId: string;
  payloadSha256: string;
  payload: ExactResultAttestationPayload;
  signature: string;
}
