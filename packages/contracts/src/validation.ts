import {
  ChangeState,
  type AuditEvent,
  type BaseReference,
  type Capability,
  type CreateChangeRequest,
  type PrivateChange,
  type PublicationPolicy,
  type SnapshotRecord,
  type StartRunRequest,
  type ExactResultAttestationPayload,
  type SignedExactResultAttestation,
} from "./types.js";

export class ContractValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Contract validation failed: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,127})$/;

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value);
}

export function assertSafeIdentifier(
  value: unknown,
  fieldName = "identifier",
): asserts value is string {
  if (!isSafeIdentifier(value)) {
    throw new ContractValidationError([
      `${fieldName} must be 1-128 characters using only letters, numbers, underscores, or hyphens`,
    ]);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function requireCondition(condition: boolean, message: string, issues: string[]): void {
  if (!condition) issues.push(message);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function assertExactResultAttestationPayload(value: unknown): asserts value is ExactResultAttestationPayload {
  const issues: string[] = [];
  requireCondition(isRecord(value), "attestation payload must be an object", issues);
  if (isRecord(value)) {
    requireCondition(hasOnlyKeys(value, ["version", "attestationId", "issuer", "issuedAt", "repositoryUrl", "baseCommit", "patchSha256", "recipeSha256", "toolVersion", "gates", "publicationIntent", "publicationReceipt"]), "attestation payload contains unknown fields", issues);
    requireCondition(value.version === 1, "attestation payload version is unsupported", issues);
    for (const field of ["attestationId", "issuer", "toolVersion"] as const) requireCondition(isNonEmptyString(value[field]) && String(value[field]).length <= 200, `${field} must be a 1-200 character string`, issues);
    requireCondition(isIsoDate(value.issuedAt), "issuedAt must be an ISO date", issues);
    requireCondition(GIT_OBJECT_ID_PATTERN.test(String(value.baseCommit ?? "")), "baseCommit must be a full Git object ID", issues);
    requireCondition(SHA256_PATTERN.test(String(value.patchSha256 ?? "")), "patchSha256 must be a SHA-256 digest", issues);
    requireCondition(value.recipeSha256 === null || SHA256_PATTERN.test(String(value.recipeSha256 ?? "")), "recipeSha256 must be null or a SHA-256 digest", issues);
    if (isNonEmptyString(value.repositoryUrl)) {
      try {
        const url = new URL(value.repositoryUrl);
        requireCondition(url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && !url.username && !url.password && !url.port && !url.search && !url.hash && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname), "repositoryUrl must be a credential-free canonical GitHub URL", issues);
      } catch { issues.push("repositoryUrl must be a valid URL"); }
    } else issues.push("repositoryUrl must be a non-empty string");
    requireCondition(Array.isArray(value.gates), "gates must be an array", issues);
    if (Array.isArray(value.gates)) {
      requireCondition(value.gates.length <= 128, "gates must contain at most 128 outcomes", issues);
      const names = new Set<string>();
      let previousName: string | undefined;
      for (const [index, gate] of value.gates.entries()) {
        requireCondition(isRecord(gate), `gates[${index}] must be an object`, issues);
        if (!isRecord(gate)) continue;
        requireCondition(hasOnlyKeys(gate, ["name", "status", "evidenceSha256"]), `gates[${index}] contains unknown fields`, issues);
        requireCondition(isNonEmptyString(gate.name) && String(gate.name).length <= 200, `gates[${index}].name is invalid`, issues);
        if (typeof gate.name === "string") {
          requireCondition(!names.has(gate.name), `gates[${index}].name is duplicated`, issues);
          requireCondition(previousName === undefined || previousName < gate.name, "gates must be sorted by name", issues);
          names.add(gate.name);
          previousName = gate.name;
        }
        requireCondition(["passed", "failed", "skipped", "unavailable"].includes(String(gate.status)), `gates[${index}].status is invalid`, issues);
        requireCondition(gate.evidenceSha256 === null || SHA256_PATTERN.test(String(gate.evidenceSha256 ?? "")), `gates[${index}].evidenceSha256 is invalid`, issues);
      }
    }
    const intent = value.publicationIntent;
    requireCondition(isRecord(intent), "publicationIntent must be an object", issues);
    if (isRecord(intent)) {
      requireCondition(hasOnlyKeys(intent, ["intentId", "mode", "branchName", "expiresAt"]), "publicationIntent contains unknown fields", issues);
      requireCondition(isNonEmptyString(intent.intentId) && String(intent.intentId).length <= 200, "publicationIntent.intentId is invalid", issues);
      requireCondition(intent.mode === "draft_pull_request" || intent.mode === "git_patch", "publicationIntent.mode is invalid", issues);
      requireCondition(intent.branchName === null || (isNonEmptyString(intent.branchName) && String(intent.branchName).startsWith("veil/") && !String(intent.branchName).includes("..")), "publicationIntent.branchName is invalid", issues);
      requireCondition(intent.mode !== "draft_pull_request" || typeof intent.branchName === "string", "draft pull request intent requires a branch", issues);
      requireCondition(intent.mode !== "git_patch" || intent.branchName === null, "git patch intent must not have a branch", issues);
      requireCondition(isIsoDate(intent.expiresAt), "publicationIntent.expiresAt must be an ISO date", issues);
    }
    const receipt = value.publicationReceipt;
    if (receipt !== undefined) {
      requireCondition(isRecord(receipt), "publicationReceipt must be an object", issues);
      if (isRecord(receipt)) {
        requireCondition(hasOnlyKeys(receipt, ["publishedAt", "commitSha", "draftPullRequestUrl"]), "publicationReceipt contains unknown fields", issues);
        requireCondition(isIsoDate(receipt.publishedAt), "publicationReceipt.publishedAt must be an ISO date", issues);
        requireCondition(receipt.commitSha === null || GIT_OBJECT_ID_PATTERN.test(String(receipt.commitSha ?? "")), "publicationReceipt.commitSha must be null or a full Git object ID", issues);
        requireCondition(receipt.draftPullRequestUrl === null || isCanonicalGitHubPullRequestUrl(receipt.draftPullRequestUrl, value.repositoryUrl), "publicationReceipt.draftPullRequestUrl must be null or a canonical GitHub pull request URL for the attested repository", issues);
        if (isRecord(intent) && isIsoDate(receipt.publishedAt) && isIsoDate(intent.expiresAt) && isIsoDate(value.issuedAt)) {
          const publishedAt = Date.parse(receipt.publishedAt as string);
          requireCondition(publishedAt >= Date.parse(value.issuedAt as string), "publicationReceipt predates attestation issuance", issues);
          requireCondition(publishedAt <= Date.parse(intent.expiresAt as string), "publicationReceipt occurred after authorization expiry", issues);
          requireCondition(intent.mode !== "draft_pull_request" || typeof receipt.commitSha === "string", "draft pull request receipt requires a commit", issues);
          requireCondition(intent.mode !== "git_patch" || (receipt.commitSha === null && receipt.draftPullRequestUrl === null), "git patch receipt must not claim a commit or pull request", issues);
        }
      }
    }
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

function isCanonicalGitHubPullRequestUrl(value: unknown, repositoryUrl: unknown): boolean {
  if (typeof value !== "string" || typeof repositoryUrl !== "string") return false;
  try {
    const url = new URL(value);
    const repository = new URL(repositoryUrl);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && !url.username && !url.password && !url.port && !url.search && !url.hash && new RegExp(`^${escapeRegExp(repository.pathname)}/pull/[1-9][0-9]*$`).test(url.pathname);
  } catch { return false; }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertSignedExactResultAttestation(value: unknown): asserts value is SignedExactResultAttestation {
  const issues: string[] = [];
  requireCondition(isRecord(value), "signed attestation must be an object", issues);
  if (isRecord(value)) {
    requireCondition(hasOnlyKeys(value, ["version", "algorithm", "keyId", "payloadSha256", "payload", "signature"]), "signed attestation contains unknown fields", issues);
    requireCondition(value.version === 1, "signed attestation version is unsupported", issues);
    requireCondition(value.algorithm === "Ed25519", "signed attestation algorithm is unsupported", issues);
    requireCondition(isNonEmptyString(value.keyId) && String(value.keyId).length <= 200, "signed attestation keyId is invalid", issues);
    requireCondition(SHA256_PATTERN.test(String(value.payloadSha256 ?? "")), "signed attestation payloadSha256 is invalid", issues);
    let signatureLength = 0;
    if (typeof value.signature === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value.signature)) {
      try { signatureLength = Buffer.from(value.signature, "base64").length; } catch { signatureLength = 0; }
    }
    requireCondition(signatureLength === 64, "signed attestation signature must be a 64-byte Ed25519 signature", issues);
    try { assertExactResultAttestationPayload(value.payload); }
    catch (error) {
      if (error instanceof ContractValidationError) issues.push(...error.issues);
      else throw error;
    }
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertBaseReference(value: unknown): asserts value is BaseReference {
  const issues: string[] = [];
  requireCondition(isRecord(value), "base must be an object", issues);
  if (isRecord(value)) {
    for (const field of ["repositoryUrl", "owner", "repository", "defaultBranch", "baseCommit"] as const) {
      requireCondition(isNonEmptyString(value[field]), `base.${field} must be a non-empty string`, issues);
    }
    requireCondition(isIsoDate(value.importedAt), "base.importedAt must be an ISO date", issues);
    if (isNonEmptyString(value.repositoryUrl)) {
      try {
        const url = new URL(value.repositoryUrl);
        requireCondition(url.protocol === "https:", "base.repositoryUrl must use HTTPS", issues);
      } catch {
        issues.push("base.repositoryUrl must be a valid URL");
      }
    }
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertPrivateChange(value: unknown): asserts value is PrivateChange {
  const issues: string[] = [];
  requireCondition(isRecord(value), "change must be an object", issues);
  if (isRecord(value)) {
    for (const field of ["id", "title", "description", "ownerIdentityId"] as const) {
      requireCondition(isNonEmptyString(value[field]), `${field} must be a non-empty string`, issues);
    }
    try {
      assertBaseReference(value.base);
    } catch (error) {
      if (error instanceof ContractValidationError) issues.push(...error.issues);
      else throw error;
    }
    requireCondition(Object.values(ChangeState).includes(value.state as ChangeState), "state is invalid", issues);
    requireCondition(value.rootSnapshotId === null || isNonEmptyString(value.rootSnapshotId), "rootSnapshotId must be null or a string", issues);
    requireCondition(value.selectedCandidateId === null || isNonEmptyString(value.selectedCandidateId), "selectedCandidateId must be null or a string", issues);
    requireCondition(isIsoDate(value.createdAt), "createdAt must be an ISO date", issues);
    requireCondition(isIsoDate(value.updatedAt), "updatedAt must be an ISO date", issues);
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertSnapshotRecord(value: unknown): asserts value is SnapshotRecord {
  const issues: string[] = [];
  requireCondition(isRecord(value), "snapshot must be an object", issues);
  if (isRecord(value)) {
    for (const field of ["id", "changeId", "actorIdentityId", "encryptedManifestObjectId", "treeHash"] as const) {
      requireCondition(isNonEmptyString(value[field]), `${field} must be a non-empty string`, issues);
    }
    requireCondition(typeof value.headerMac === "string" && /^[a-f0-9]{64}$/.test(value.headerMac), "headerMac must be an HMAC-SHA256 digest", issues);
    requireCondition(value.parentSnapshotId === null || isNonEmptyString(value.parentSnapshotId), "parentSnapshotId must be null or a string", issues);
    requireCondition(Array.isArray(value.evidenceObjectIds) && value.evidenceObjectIds.every(isNonEmptyString), "evidenceObjectIds must contain strings", issues);
    requireCondition(["import", "agent_file_change", "agent_final", "manual", "recovered"].includes(value.reason as string), "reason is invalid", issues);
    requireCondition(Number.isSafeInteger(value.eventSequence) && (value.eventSequence as number) >= 0, "eventSequence must be a non-negative integer", issues);
    requireCondition(isIsoDate(value.createdAt), "createdAt must be an ISO date", issues);
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertAuditEvent(value: unknown): asserts value is AuditEvent {
  const issues: string[] = [];
  requireCondition(isRecord(value), "event must be an object", issues);
  if (isRecord(value)) {
    for (const field of ["id", "changeId", "type", "hash"] as const) {
      requireCondition(isNonEmptyString(value[field]), `${field} must be a non-empty string`, issues);
    }
    requireCondition(Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0, "sequence must be a positive integer", issues);
    requireCondition(isIsoDate(value.occurredAt), "occurredAt must be an ISO date", issues);
    requireCondition(value.actorIdentityId === null || isNonEmptyString(value.actorIdentityId), "actorIdentityId must be null or a string", issues);
    requireCondition(value.previousHash === null || isNonEmptyString(value.previousHash), "previousHash must be null or a string", issues);
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertCreateChangeRequest(value: unknown): asserts value is CreateChangeRequest {
  if (!isRecord(value)) throw new ContractValidationError(["request must be an object"]);
  const issues: string[] = [];
  requireCondition(isNonEmptyString(value.title), "title must be a non-empty string", issues);
  requireCondition(isNonEmptyString(value.description), "description must be a non-empty string", issues);
  try {
    assertBaseReference(value.base);
  } catch (error) {
    if (error instanceof ContractValidationError) issues.push(...error.issues);
    else throw error;
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertStartRunRequest(value: unknown): asserts value is StartRunRequest {
  const issues: string[] = [];
  requireCondition(isRecord(value), "request must be an object", issues);
  if (isRecord(value)) {
    requireCondition(isNonEmptyString(value.instructions), "instructions must be a non-empty string", issues);
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertPublicationPolicy(value: unknown): asserts value is PublicationPolicy {
  const issues: string[] = [];
  requireCondition(isRecord(value), "policy must be an object", issues);
  if (isRecord(value)) {
    requireCondition(value.mode === "draft_pull_request" || value.mode === "git_patch", "mode is invalid", issues);
    requireCondition(isNonEmptyString(value.branchName) && !String(value.branchName).startsWith("-") && !String(value.branchName).includes(".."), "branchName is invalid", issues);
    for (const field of ["requireExplicitConfirmation", "openAsDraft", "requirePassingVerification"] as const) {
      requireCondition(typeof value[field] === "boolean", `${field} must be boolean`, issues);
    }
    requireCondition(Array.isArray(value.stripPrivatePaths) && value.stripPrivatePaths.every(isNonEmptyString), "stripPrivatePaths must contain strings", issues);
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertCapabilities(value: unknown): asserts value is Capability[] {
  const valid = new Set<Capability>(["read", "modify", "review", "publish"]);
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => valid.has(item as Capability))) {
    throw new ContractValidationError(["capabilities must contain at least one valid capability"]);
  }
}

export function parseJson<T>(raw: string, validator: (value: unknown) => asserts value is T): T {
  const value: unknown = JSON.parse(raw);
  validator(value);
  return value;
}
