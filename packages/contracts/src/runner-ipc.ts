import type { JsonValue } from "./types.js";
import { ContractValidationError, assertSafeIdentifier, isRecord } from "./validation.js";

/**
 * Local, browser-independent protocol between a Veil client (CLI, IDE, or
 * local web UI) and the long-lived Veil Runner. It intentionally has no
 * pairing, browser, cloud, or credential fields.
 */
export const runnerIpcProtocolVersions = [1] as const;
export type RunnerIpcProtocolVersion = (typeof runnerIpcProtocolVersions)[number];

export const runnerIpcCapabilities = [
  "change", "run", "log", "capture", "evaluate", "cleanup", "workspace", "cancel", "publish",
] as const;
export type RunnerIpcCapability = (typeof runnerIpcCapabilities)[number];

export const runnerIpcOperations = [
  "change.create", "change.get", "change.list", "change.update",
  "run.start", "run.get", "run.cancel",
  "log.list", "capture.create", "evaluate.start",
  "cleanup.start", "workspace.open", "workspace.checkpoint", "workspace.destroy", "publish.create",
] as const;
export type RunnerIpcOperation = (typeof runnerIpcOperations)[number];

/** The capability required before a client may issue an operation. */
export const runnerIpcOperationCapabilities: Readonly<Record<RunnerIpcOperation, RunnerIpcCapability>> = {
  "change.create": "change",
  "change.get": "change",
  "change.list": "change",
  "change.update": "change",
  "run.start": "run",
  "run.get": "run",
  "run.cancel": "cancel",
  "log.list": "log",
  "capture.create": "capture",
  "evaluate.start": "evaluate",
  "cleanup.start": "cleanup",
  "workspace.open": "workspace",
  "workspace.checkpoint": "workspace",
  "workspace.destroy": "workspace",
  "publish.create": "publish",
};

export const runnerIpcErrorCodes = [
  "UNSUPPORTED_PROTOCOL",
  "UNSUPPORTED_CAPABILITY",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_CURSOR",
  "OPERATION_CANCELLED",
  "RUNNER_UNAVAILABLE",
  "CONTEXT_BUSY",
  "RUNNER_INTERRUPTED",
  "INTERNAL",
] as const;
export type RunnerIpcErrorCode = (typeof runnerIpcErrorCodes)[number];

export interface RunnerIpcClientHello {
  kind: "runner.hello";
  protocolVersions: number[];
  capabilities: RunnerIpcCapability[];
  client: { name: string; version: string };
}

export interface RunnerIpcServerHello {
  kind: "runner.hello_ack";
  protocolVersion: RunnerIpcProtocolVersion;
  capabilities: RunnerIpcCapability[];
  runner: { id: string; version: string };
  sessionId: string;
}

export interface RunnerIpcNegotiationFailure {
  ok: false;
  error: RunnerIpcError;
}

export interface RunnerIpcNegotiationSuccess {
  ok: true;
  hello: RunnerIpcServerHello;
}

export type RunnerIpcNegotiationResult = RunnerIpcNegotiationSuccess | RunnerIpcNegotiationFailure;

/**
 * Durable local operation envelope. `requestId` is transport correlation;
 * `idempotencyKey` is persisted by the Runner for retry-safe mutation.
 */
export interface RunnerIpcRequest {
  protocolVersion: RunnerIpcProtocolVersion;
  requestId: string;
  idempotencyKey: string;
  operation: RunnerIpcOperation;
  /** Opaque continuation token from a prior response or event stream. */
  cursor?: string;
  payload: JsonValue;
}

/** Durable references returned by the Runner; none are host filesystem paths. */
export interface RunnerIpcReferences {
  changeId?: string;
  runId?: string;
  workspaceId?: string;
  viewId?: string;
  candidateId?: string;
  captureId?: string;
  evaluationId?: string;
}

export interface RunnerIpcError {
  code: RunnerIpcErrorCode;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

export interface RunnerIpcResponse {
  protocolVersion: RunnerIpcProtocolVersion;
  requestId: string;
  idempotencyKey: string;
  operation: RunnerIpcOperation;
  /** A durable operation ID, retained across daemon restarts. */
  operationId: string;
  status: "accepted" | "completed" | "failed" | "cancelled";
  references: RunnerIpcReferences;
  /** Opaque token for listing more results or resuming event consumption. */
  cursor: string | null;
  result: JsonValue | null;
  error?: RunnerIpcError;
}

export const runnerIpcEventTypes = [
  "operation.accepted", "operation.progress", "operation.completed", "operation.failed", "operation.cancelled",
] as const;
export type RunnerIpcEventType = (typeof runnerIpcEventTypes)[number];

/** Ordered, resumable lifecycle event for an accepted operation. */
export interface RunnerIpcEvent {
  protocolVersion: RunnerIpcProtocolVersion;
  eventId: string;
  operationId: string;
  sequence: number;
  cursor: string;
  type: RunnerIpcEventType;
  occurredAt: string;
  references: RunnerIpcReferences;
  data: JsonValue;
}

const VALID_CAPABILITIES = new Set<string>(runnerIpcCapabilities);
const VALID_OPERATIONS = new Set<string>(runnerIpcOperations);
const VALID_ERROR_CODES = new Set<string>(runnerIpcErrorCodes);
const VALID_EVENT_TYPES = new Set<string>(runnerIpcEventTypes);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_CURSOR_LENGTH = 512;

function requireCondition(condition: boolean, message: string, issues: string[]): void {
  if (!condition) issues.push(message);
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  name: string,
  issues: string[],
): void {
  const expected = new Set(fields);
  const unexpected = Object.keys(value).filter((field) => !expected.has(field));
  requireCondition(unexpected.length === 0, `${name} contains unexpected fields: ${unexpected.join(", ")}`, issues);
}

function collectIdentifier(value: unknown, field: string, issues: string[]): void {
  try {
    assertSafeIdentifier(value, field);
  } catch (error) {
    if (error instanceof ContractValidationError) issues.push(...error.issues);
    else throw error;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function isStrictIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isOpaqueCursor(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_CURSOR_LENGTH
    && !/[\u0000-\u001F\u007F]/.test(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32 || value === null || typeof value === "string" || typeof value === "boolean") return depth <= 32;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function assertCapabilityList(value: unknown, field: string, issues: string[], allowEmpty = false): void {
  requireCondition(Array.isArray(value), `${field} must be an array`, issues);
  if (!Array.isArray(value)) return;
  requireCondition(allowEmpty || value.length > 0, `${field} must not be empty`, issues);
  requireCondition(
    value.every((item) => typeof item === "string" && VALID_CAPABILITIES.has(item)),
    `${field} contains an unsupported capability`,
    issues,
  );
  requireCondition(new Set(value).size === value.length, `${field} must not contain duplicates`, issues);
}

function assertReferences(value: unknown, field: string, issues: string[]): void {
  const fields = ["changeId", "runId", "workspaceId", "viewId", "candidateId", "captureId", "evaluationId"] as const;
  requireCondition(isRecord(value), `${field} must be an object`, issues);
  if (!isRecord(value)) return;
  requireExactFields(value, fields, field, issues);
  for (const name of fields) {
    if (value[name] !== undefined) collectIdentifier(value[name], `${field}.${name}`, issues);
  }
}

function assertPayloadObject(
  value: unknown,
  fields: readonly string[],
  name: string,
  issues: string[],
): value is Record<string, unknown> {
  requireCondition(isRecord(value), `${name} must be an object`, issues);
  if (!isRecord(value)) return false;
  requireExactFields(value, fields, name, issues);
  return true;
}

function assertRunnerOperationPayload(operation: RunnerIpcOperation, payload: unknown, issues: string[]): void {
  switch (operation) {
    case "change.create": {
      if (!assertPayloadObject(payload, ["title", "description", "repositoryUrl", "ref", "localRepository"], "change.create payload", issues)) return;
      requireCondition(isNonEmptyString(payload.title), "change.create payload.title must be a non-empty string", issues);
      requireCondition(isNonEmptyString(payload.description), "change.create payload.description must be a non-empty string", issues);
      requireCondition(isNonEmptyString(payload.repositoryUrl), "change.create payload.repositoryUrl must be a non-empty string", issues);
      if (isNonEmptyString(payload.repositoryUrl)) {
        try { requireCondition(new URL(payload.repositoryUrl).protocol === "https:", "change.create payload.repositoryUrl must use HTTPS", issues); }
        catch { issues.push("change.create payload.repositoryUrl must be a valid URL"); }
      }
      requireCondition(payload.ref === undefined || isNonEmptyString(payload.ref), "change.create payload.ref must be a non-empty string when present", issues);
      if (payload.localRepository !== undefined) {
        if (assertPayloadObject(payload.localRepository, ["sourcePath", "baseCommit"], "change.create payload.localRepository", issues)) {
          requireCondition(isNonEmptyString(payload.localRepository.sourcePath), "change.create localRepository.sourcePath is invalid", issues);
          requireCondition(typeof payload.localRepository.sourcePath !== "string" || payload.localRepository.sourcePath.startsWith("/"), "change.create localRepository.sourcePath must be absolute", issues);
          requireCondition(typeof payload.localRepository.baseCommit === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(payload.localRepository.baseCommit), "change.create localRepository.baseCommit is invalid", issues);
        }
      }
      return;
    }
    case "change.get":
      assertSingleIdentifierPayload(payload, "changeId", operation, issues);
      return;
    case "change.update": {
      if (!assertPayloadObject(payload, ["changeId", "title"], "change.update payload", issues)) return;
      collectIdentifier(payload.changeId, "change.update payload.changeId", issues);
      requireCondition(isNonEmptyString(payload.title), "change.update payload.title must be a non-empty string", issues);
      requireCondition(typeof payload.title !== "string" || payload.title.trim().length <= 120, "change.update payload.title must be at most 120 characters", issues);
      return;
    }
    case "change.list":
      if (!assertPayloadObject(payload, ["limit"], "change.list payload", issues)) return;
      requireCondition(payload.limit === undefined || (Number.isSafeInteger(payload.limit) && (payload.limit as number) >= 1 && (payload.limit as number) <= 100), "change.list payload.limit must be an integer from 1 to 100 when present", issues);
      return;
    case "run.start": {
      if (!assertPayloadObject(payload, ["changeId", "objective", "model"], "run.start payload", issues)) return;
      collectIdentifier(payload.changeId, "run.start payload.changeId", issues);
      requireCondition(isNonEmptyString(payload.objective), "run.start payload.objective must be a non-empty string", issues);
      requireCondition(payload.model === undefined || (isNonEmptyString(payload.model) && payload.model.length <= 200), "run.start payload.model is invalid", issues);
      return;
    }
    case "run.get":
    case "run.cancel":
    case "log.list":
      assertSingleIdentifierPayload(payload, "runId", operation, issues);
      return;
    case "capture.create": {
      if (!assertPayloadObject(payload, ["changeId", "viewId", "workspaceId"], "capture.create payload", issues)) return;
      collectIdentifier(payload.changeId, "capture.create payload.changeId", issues);
      collectIdentifier(payload.viewId, "capture.create payload.viewId", issues);
      if (payload.workspaceId !== undefined) collectIdentifier(payload.workspaceId, "capture.create payload.workspaceId", issues);
      return;
    }
    case "evaluate.start": {
      if (!assertPayloadObject(payload, ["changeId", "runId"], "evaluate.start payload", issues)) return;
      collectIdentifier(payload.changeId, "evaluate.start payload.changeId", issues);
      collectIdentifier(payload.runId, "evaluate.start payload.runId", issues);
      return;
    }
    case "cleanup.start": {
      if (!assertPayloadObject(payload, ["changeId", "runId", "workspaceId"], "cleanup.start payload", issues)) return;
      collectIdentifier(payload.changeId, "cleanup.start payload.changeId", issues);
      requireCondition(payload.runId !== undefined || payload.workspaceId !== undefined, "cleanup.start payload must include runId or workspaceId", issues);
      if (payload.runId !== undefined) collectIdentifier(payload.runId, "cleanup.start payload.runId", issues);
      if (payload.workspaceId !== undefined) collectIdentifier(payload.workspaceId, "cleanup.start payload.workspaceId", issues);
      return;
    }
    case "workspace.open": {
      if (!assertPayloadObject(payload, ["changeId", "launch"], "workspace.open payload", issues)) return;
      collectIdentifier(payload.changeId, "workspace.open payload.changeId", issues);
      requireCondition(payload.launch === "vscode" || payload.launch === "cursor" || payload.launch === "cmux" || payload.launch === "none", "workspace.open payload.launch is invalid", issues);
      return;
    }
    case "workspace.checkpoint": {
      if (!assertPayloadObject(payload, ["changeId", "workspaceId"], "workspace.checkpoint payload", issues)) return;
      collectIdentifier(payload.changeId, "workspace.checkpoint payload.changeId", issues);
      collectIdentifier(payload.workspaceId, "workspace.checkpoint payload.workspaceId", issues);
      return;
    }
    case "workspace.destroy":
      assertSingleIdentifierPayload(payload, "workspaceId", operation, issues);
      return;
    case "publish.create": {
      if (!assertPayloadObject(payload, ["changeId", "confirm", "mode", "branch", "createDraftPullRequest", "allowUnchecked", "publicationIntentId", "expectedCandidateId", "expectedPatchSha256", "localRepository"], "publish.create payload", issues)) return;
      collectIdentifier(payload.changeId, "publish.create payload.changeId", issues);
      requireCondition(payload.confirm === true, "publish.create payload.confirm must be true", issues);
      requireCondition(payload.mode === undefined || payload.mode === "draft-pr" || payload.mode === "patch", "publish.create payload.mode is invalid", issues);
      requireCondition(payload.branch === undefined || isNonEmptyString(payload.branch), "publish.create payload.branch must be a non-empty string when present", issues);
      requireCondition(payload.createDraftPullRequest === undefined || typeof payload.createDraftPullRequest === "boolean", "publish.create payload.createDraftPullRequest must be boolean when present", issues);
      requireCondition(payload.allowUnchecked === undefined || typeof payload.allowUnchecked === "boolean", "publish.create payload.allowUnchecked must be boolean when present", issues);
      const expectedBindingCount = [payload.publicationIntentId, payload.expectedCandidateId, payload.expectedPatchSha256].filter((value) => value !== undefined).length;
      requireCondition(expectedBindingCount === 0 || expectedBindingCount === 3, "publish.create exact publication binding must be complete", issues);
      if (payload.publicationIntentId !== undefined) collectIdentifier(payload.publicationIntentId, "publish.create payload.publicationIntentId", issues);
      if (payload.expectedCandidateId !== undefined) collectIdentifier(payload.expectedCandidateId, "publish.create payload.expectedCandidateId", issues);
      requireCondition(payload.expectedPatchSha256 === undefined || typeof payload.expectedPatchSha256 === "string" && /^[0-9a-f]{64}$/.test(payload.expectedPatchSha256), "publish.create payload.expectedPatchSha256 is invalid", issues);
      if (payload.localRepository !== undefined) {
        if (assertPayloadObject(payload.localRepository, ["sourcePath", "baseCommit"], "publish.create payload.localRepository", issues)) {
          requireCondition(isNonEmptyString(payload.localRepository.sourcePath), "publish.create localRepository.sourcePath is invalid", issues);
          requireCondition(typeof payload.localRepository.sourcePath !== "string" || payload.localRepository.sourcePath.startsWith("/"), "publish.create localRepository.sourcePath must be absolute", issues);
          requireCondition(typeof payload.localRepository.baseCommit === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(payload.localRepository.baseCommit), "publish.create localRepository.baseCommit is invalid", issues);
        }
      }
      return;
    }
  }
}

function assertSingleIdentifierPayload(value: unknown, field: string, operation: string, issues: string[]): void {
  if (!assertPayloadObject(value, [field], `${operation} payload`, issues)) return;
  collectIdentifier(value[field], `${operation} payload.${field}`, issues);
}

export function assertRunnerIpcClientHello(value: unknown): asserts value is RunnerIpcClientHello {
  const issues: string[] = [];
  requireCondition(isRecord(value), "runner client hello must be an object", issues);
  if (isRecord(value)) {
    requireExactFields(value, ["kind", "protocolVersions", "capabilities", "client"], "runner client hello", issues);
    requireCondition(value.kind === "runner.hello", "runner client hello.kind must be runner.hello", issues);
    requireCondition(Array.isArray(value.protocolVersions) && value.protocolVersions.length > 0 && value.protocolVersions.every((version) => Number.isSafeInteger(version) && (version as number) > 0 && (version as number) <= 100), "runner client hello.protocolVersions must contain positive integer versions", issues);
    if (Array.isArray(value.protocolVersions)) requireCondition(new Set(value.protocolVersions).size === value.protocolVersions.length, "runner client hello.protocolVersions must not contain duplicates", issues);
    assertCapabilityList(value.capabilities, "runner client hello.capabilities", issues);
    if (assertPayloadObject(value.client, ["name", "version"], "runner client hello.client", issues)) {
      requireCondition(isNonEmptyString(value.client.name), "runner client hello.client.name must be a non-empty string", issues);
      requireCondition(isNonEmptyString(value.client.version), "runner client hello.client.version must be a non-empty string", issues);
    }
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertRunnerIpcServerHello(value: unknown): asserts value is RunnerIpcServerHello {
  const issues: string[] = [];
  requireCondition(isRecord(value), "runner server hello must be an object", issues);
  if (isRecord(value)) {
    requireExactFields(value, ["kind", "protocolVersion", "capabilities", "runner", "sessionId"], "runner server hello", issues);
    requireCondition(value.kind === "runner.hello_ack", "runner server hello.kind must be runner.hello_ack", issues);
    requireCondition(value.protocolVersion === 1, "runner server hello.protocolVersion must be 1", issues);
    assertCapabilityList(value.capabilities, "runner server hello.capabilities", issues);
    if (assertPayloadObject(value.runner, ["id", "version"], "runner server hello.runner", issues)) {
      collectIdentifier(value.runner.id, "runner server hello.runner.id", issues);
      requireCondition(isNonEmptyString(value.runner.version), "runner server hello.runner.version must be a non-empty string", issues);
    }
    collectIdentifier(value.sessionId, "runner server hello.sessionId", issues);
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertRunnerIpcRequest(value: unknown): asserts value is RunnerIpcRequest {
  const issues: string[] = [];
  requireCondition(isRecord(value), "runner request must be an object", issues);
  if (isRecord(value)) {
    requireExactFields(value, ["protocolVersion", "requestId", "idempotencyKey", "operation", "cursor", "payload"], "runner request", issues);
    requireCondition(value.protocolVersion === 1, "runner request.protocolVersion must be 1", issues);
    collectIdentifier(value.requestId, "runner request.requestId", issues);
    collectIdentifier(value.idempotencyKey, "runner request.idempotencyKey", issues);
    requireCondition(typeof value.operation === "string" && VALID_OPERATIONS.has(value.operation), "runner request.operation is unsupported", issues);
    if (value.cursor !== undefined) requireCondition(isOpaqueCursor(value.cursor), "runner request.cursor must be a non-empty opaque cursor", issues);
    if (typeof value.operation === "string" && VALID_OPERATIONS.has(value.operation)) {
      assertRunnerOperationPayload(value.operation as RunnerIpcOperation, value.payload, issues);
    }
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertRunnerIpcError(value: unknown): asserts value is RunnerIpcError {
  const issues: string[] = [];
  requireCondition(isRecord(value), "runner error must be an object", issues);
  if (isRecord(value)) {
    requireExactFields(value, ["code", "message", "retryable", "details"], "runner error", issues);
    requireCondition(typeof value.code === "string" && VALID_ERROR_CODES.has(value.code), "runner error.code is invalid", issues);
    requireCondition(isNonEmptyString(value.message), "runner error.message must be a non-empty string", issues);
    requireCondition(typeof value.retryable === "boolean", "runner error.retryable must be boolean", issues);
    if (value.details !== undefined) requireCondition(isJsonValue(value.details), "runner error.details must be JSON-compatible", issues);
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertRunnerIpcResponse(value: unknown): asserts value is RunnerIpcResponse {
  const issues: string[] = [];
  requireCondition(isRecord(value), "runner response must be an object", issues);
  if (isRecord(value)) {
    requireExactFields(value, ["protocolVersion", "requestId", "idempotencyKey", "operation", "operationId", "status", "references", "cursor", "result", "error"], "runner response", issues);
    requireCondition(value.protocolVersion === 1, "runner response.protocolVersion must be 1", issues);
    collectIdentifier(value.requestId, "runner response.requestId", issues);
    collectIdentifier(value.idempotencyKey, "runner response.idempotencyKey", issues);
    requireCondition(typeof value.operation === "string" && VALID_OPERATIONS.has(value.operation), "runner response.operation is unsupported", issues);
    collectIdentifier(value.operationId, "runner response.operationId", issues);
    requireCondition(value.status === "accepted" || value.status === "completed" || value.status === "failed" || value.status === "cancelled", "runner response.status is invalid", issues);
    assertReferences(value.references, "runner response.references", issues);
    requireCondition(value.cursor === null || isOpaqueCursor(value.cursor), "runner response.cursor must be null or an opaque cursor", issues);
    requireCondition(value.result === null || isJsonValue(value.result), "runner response.result must be null or JSON-compatible", issues);
    if (value.error !== undefined) {
      try { assertRunnerIpcError(value.error); }
      catch (error) { if (error instanceof ContractValidationError) issues.push(...error.issues); else throw error; }
    }
    requireCondition(value.status !== "failed" || value.error !== undefined, "runner response.error is required when status is failed", issues);
    requireCondition(value.status === "failed" || value.error === undefined, "runner response.error is only allowed when status is failed", issues);
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertRunnerIpcEvent(value: unknown): asserts value is RunnerIpcEvent {
  const issues: string[] = [];
  requireCondition(isRecord(value), "runner event must be an object", issues);
  if (isRecord(value)) {
    requireExactFields(value, ["protocolVersion", "eventId", "operationId", "sequence", "cursor", "type", "occurredAt", "references", "data"], "runner event", issues);
    requireCondition(value.protocolVersion === 1, "runner event.protocolVersion must be 1", issues);
    collectIdentifier(value.eventId, "runner event.eventId", issues);
    collectIdentifier(value.operationId, "runner event.operationId", issues);
    requireCondition(Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0, "runner event.sequence must be a positive integer", issues);
    requireCondition(isOpaqueCursor(value.cursor), "runner event.cursor must be an opaque cursor", issues);
    requireCondition(typeof value.type === "string" && VALID_EVENT_TYPES.has(value.type), "runner event.type is invalid", issues);
    requireCondition(isStrictIsoTimestamp(value.occurredAt), "runner event.occurredAt must be an ISO timestamp", issues);
    assertReferences(value.references, "runner event.references", issues);
    requireCondition(isJsonValue(value.data), "runner event.data must be JSON-compatible", issues);
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

/**
 * Selects protocol v1 and the capability intersection without coupling any
 * surface to a browser or hosted pairing. The caller supplies its Runner ID
 * and session ID because their generation and persistence are runtime work.
 */
export function negotiateRunnerIpc(
  client: RunnerIpcClientHello,
  runner: { id: string; version: string; capabilities: RunnerIpcCapability[]; sessionId: string },
): RunnerIpcNegotiationResult {
  assertRunnerIpcClientHello(client);
  const serverInput = {
    kind: "runner.hello_ack" as const,
    protocolVersion: 1 as const,
    capabilities: runner.capabilities,
    runner: { id: runner.id, version: runner.version },
    sessionId: runner.sessionId,
  };
  assertRunnerIpcServerHello(serverInput);

  if (!client.protocolVersions.includes(1)) {
    return { ok: false, error: { code: "UNSUPPORTED_PROTOCOL", message: "No mutually supported Runner IPC protocol version", retryable: false, details: { clientVersions: client.protocolVersions, runnerVersions: [...runnerIpcProtocolVersions] } } };
  }
  const capabilities = runner.capabilities.filter((capability) => client.capabilities.includes(capability));
  if (capabilities.length === 0) {
    return { ok: false, error: { code: "UNSUPPORTED_CAPABILITY", message: "No mutually supported Runner IPC capabilities", retryable: false, details: { clientCapabilities: client.capabilities, runnerCapabilities: runner.capabilities } } };
  }
  return { ok: true, hello: { ...serverInput, capabilities } };
}
