import { ContractValidationError, isRecord } from "./validation.js";
import { assertSafeIdentifier } from "./validation.js";

/**
 * The bridge transports these records, but does not interpret the encrypted
 * context or evidence objects they address. Versioning here is deliberately
 * independent from snapshot and workspace-key schemas.
 */
export const changeEventProtocolVersions = [1] as const;
export type ChangeEventProtocolVersion = (typeof changeEventProtocolVersions)[number];

export const changeEventActorTypes = ["maintainer", "codex"] as const;
export type ChangeEventActorType = (typeof changeEventActorTypes)[number];

export const changeEventSources = [
  "manual-capture",
  "agent-edit",
  "agent-final",
  "bridge-sync",
] as const;
export type ChangeEventSource = (typeof changeEventSources)[number];

export interface ChangeEventActor {
  type: ChangeEventActorType;
  identityId: string;
}

/**
 * This MAC is calculated over the canonical event payload by the holder of
 * the per-workspace integrity key. It creates a per-view tamper-evident chain;
 * the hosted control plane must treat the MAC as opaque and never receive that
 * key. The concrete key derivation and encryption envelope live outside this
 * wire contract.
 */
export interface ChangeEventIntegrity {
  algorithm: "HMAC-SHA256";
  keyId: string;
  previousEventMac: string | null;
  mac: string;
}

/**
 * Opaque, privacy-preserving provenance for one immutable snapshot transition.
 *
 * No file paths, instructions, agent output, or plaintext evidence is allowed
 * in this object. `changedPathHashes` are HMAC-SHA256 private addresses, not
 * raw SHA-256 file-name hashes. Context and evidence are separately encrypted
 * objects addressed by private object IDs.
 */
export interface ChangeEvent {
  protocolVersion: ChangeEventProtocolVersion;
  id: string;
  tenantId: string;
  workspaceId: string;
  changeId: string;
  viewId: string;
  idempotencyKey: string;
  /** Starts at one and is strictly contiguous within tenant/workspace/change/view. */
  sequence: number;
  parentSnapshotId: string;
  resultSnapshotId: string;
  actor: ChangeEventActor;
  source: ChangeEventSource;
  encryptedContextObjectId: string | null;
  encryptedEvidenceObjectIds: string[];
  changedPathHashes: string[];
  integrity: ChangeEventIntegrity;
  createdAt: string;
}

export interface ChangeEventScope {
  tenantId: string;
  workspaceId: string;
  changeId: string;
  viewId: string;
}

export const changeEventIngressCheckpointVersions = [1] as const;
export type ChangeEventIngressCheckpointVersion = (typeof changeEventIngressCheckpointVersions)[number];

/** A bounded, opaque replay record. It deliberately contains no event payload. */
export interface ChangeEventIngressCheckpointEntry {
  sequence: number;
  eventId: string;
  idempotencyKey: string;
  /** The event HMAC is an opaque, keyed fingerprint of the complete event payload. */
  integrityMac: string;
}

/** Serializable state needed to resume one view's idempotency and ordering guard. */
export interface ChangeEventIngressCheckpoint {
  protocolVersion: ChangeEventIngressCheckpointVersion;
  scope: ChangeEventScope;
  lastSequence: number;
  lastEventMac: string | null;
  remembered: ChangeEventIngressCheckpointEntry[];
}

export interface ChangeEventIngressOptions {
  /** Maximum duplicate/replay fingerprints retained in memory and checkpoints. Defaults to 256. */
  maxRememberedEvents?: number;
}

interface RememberedIngressEvent {
  entry: ChangeEventIngressCheckpointEntry;
  /** Present for this process lifetime; checkpoints retain only the opaque HMAC fingerprint. */
  canonicalEvent?: string;
}

export type ChangeEventRejectionCode =
  | "invalid_event"
  | "tenant_mismatch"
  | "workspace_mismatch"
  | "change_mismatch"
  | "view_mismatch"
  | "event_id_reused"
  | "idempotency_key_reused"
  | "sequence_replay"
  | "sequence_gap"
  | "integrity_chain_mismatch";

export type ChangeEventIngressResult =
  | { status: "accepted"; event: ChangeEvent }
  | { status: "duplicate"; event: ChangeEvent }
  | { status: "rejected"; code: ChangeEventRejectionCode; message: string };

const PRIVATE_OBJECT_ID = /^[a-f0-9]{64}$/;
const PRIVATE_PATH_HASH = /^hmac-sha256:[a-f0-9]{64}$/;
const HMAC_FINGERPRINT = /^hmac-sha256:[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function requireCondition(condition: boolean, message: string, issues: string[]): void {
  if (!condition) issues.push(message);
}

function requireExactFields(
  value: Record<string, unknown>,
  expectedFields: readonly string[],
  objectName: string,
  issues: string[],
): void {
  const expected = new Set(expectedFields);
  const unexpected = Object.keys(value).filter((field) => !expected.has(field));
  requireCondition(
    unexpected.length === 0,
    `${objectName} contains unexpected fields: ${unexpected.join(", ")}`,
    issues,
  );
}

function collectSafeIdentifier(value: unknown, fieldName: string, issues: string[]): void {
  try {
    assertSafeIdentifier(value, fieldName);
  } catch (error) {
    if (error instanceof ContractValidationError) issues.push(...error.issues);
    else throw error;
  }
}

function isStrictIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && ISO_TIMESTAMP_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function hasUniqueLexicalValues(values: unknown, matcher: (value: unknown) => boolean): values is string[] {
  return Array.isArray(values)
    && values.every(matcher)
    && new Set(values).size === values.length
    && values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function assertChangeEventActor(value: unknown): asserts value is ChangeEventActor {
  const issues: string[] = [];
  requireCondition(isRecord(value), "event.actor must be an object", issues);
  if (isRecord(value)) {
    requireExactFields(value, ["type", "identityId"], "event.actor", issues);
    requireCondition(
      typeof value.type === "string" && (changeEventActorTypes as readonly string[]).includes(value.type),
      "event.actor.type is invalid",
      issues,
    );
    collectSafeIdentifier(value.identityId, "event.actor.identityId", issues);
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

function assertChangeEventIntegrity(value: unknown): asserts value is ChangeEventIntegrity {
  const issues: string[] = [];
  requireCondition(isRecord(value), "event.integrity must be an object", issues);
  if (isRecord(value)) {
    requireExactFields(value, ["algorithm", "keyId", "previousEventMac", "mac"], "event.integrity", issues);
    requireCondition(value.algorithm === "HMAC-SHA256", "event.integrity.algorithm must be HMAC-SHA256", issues);
    collectSafeIdentifier(value.keyId, "event.integrity.keyId", issues);
    requireCondition(
      value.previousEventMac === null || (typeof value.previousEventMac === "string" && HMAC_FINGERPRINT.test(value.previousEventMac)),
      "event.integrity.previousEventMac must be null or hmac-sha256:<64 lowercase hex>",
      issues,
    );
    requireCondition(
      typeof value.mac === "string" && HMAC_FINGERPRINT.test(value.mac),
      "event.integrity.mac must be hmac-sha256:<64 lowercase hex>",
      issues,
    );
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertChangeEventScope(value: unknown): asserts value is ChangeEventScope {
  const issues: string[] = [];
  requireCondition(isRecord(value), "change event scope must be an object", issues);
  if (isRecord(value)) {
    requireExactFields(value, ["tenantId", "workspaceId", "changeId", "viewId"], "change event scope", issues);
    for (const field of ["tenantId", "workspaceId", "changeId", "viewId"] as const) {
      collectSafeIdentifier(value[field], `scope.${field}`, issues);
    }
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

/** Runtime validator for untrusted Bridge and API wire input. */
export function assertChangeEvent(value: unknown): asserts value is ChangeEvent {
  const issues: string[] = [];
  requireCondition(isRecord(value), "change event must be an object", issues);
  if (isRecord(value)) {
    requireExactFields(
      value,
      [
        "protocolVersion", "id", "tenantId", "workspaceId", "changeId", "viewId", "idempotencyKey",
        "sequence", "parentSnapshotId", "resultSnapshotId", "actor", "source", "encryptedContextObjectId",
        "encryptedEvidenceObjectIds", "changedPathHashes", "integrity", "createdAt",
      ],
      "change event",
      issues,
    );
    requireCondition(value.protocolVersion === 1, "event.protocolVersion must be 1", issues);
    for (const field of ["id", "tenantId", "workspaceId", "changeId", "viewId", "idempotencyKey", "parentSnapshotId", "resultSnapshotId"] as const) {
      collectSafeIdentifier(value[field], `event.${field}`, issues);
    }
    requireCondition(
      isRecord(value)
        && typeof value.parentSnapshotId === "string"
        && typeof value.resultSnapshotId === "string"
        && value.parentSnapshotId !== value.resultSnapshotId,
      "event parentSnapshotId and resultSnapshotId must differ",
      issues,
    );
    requireCondition(
      Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0,
      "event.sequence must be a positive integer",
      issues,
    );
    try {
      assertChangeEventActor(value.actor);
    } catch (error) {
      if (error instanceof ContractValidationError) issues.push(...error.issues);
      else throw error;
    }
    requireCondition(
      typeof value.source === "string" && (changeEventSources as readonly string[]).includes(value.source),
      "event.source is invalid",
      issues,
    );
    requireCondition(
      value.encryptedContextObjectId === null
        || (typeof value.encryptedContextObjectId === "string" && PRIVATE_OBJECT_ID.test(value.encryptedContextObjectId)),
      "event.encryptedContextObjectId must be null or a private object ID",
      issues,
    );
    requireCondition(
      hasUniqueLexicalValues(value.encryptedEvidenceObjectIds, (entry) => typeof entry === "string" && PRIVATE_OBJECT_ID.test(entry)),
      "event.encryptedEvidenceObjectIds must contain unique, lexicographically sorted private object IDs",
      issues,
    );
    requireCondition(
      hasUniqueLexicalValues(value.changedPathHashes, (entry) => typeof entry === "string" && PRIVATE_PATH_HASH.test(entry)),
      "event.changedPathHashes must contain unique, lexicographically sorted hmac-sha256 path hashes",
      issues,
    );
    try {
      assertChangeEventIntegrity(value.integrity);
    } catch (error) {
      if (error instanceof ContractValidationError) issues.push(...error.issues);
      else throw error;
    }
    requireCondition(isStrictIsoTimestamp(value.createdAt), "event.createdAt must be an ISO timestamp", issues);
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

export function assertChangeEventIngressCheckpoint(
  value: unknown,
  options: ChangeEventIngressOptions = {},
): asserts value is ChangeEventIngressCheckpoint {
  const maxRememberedEvents = resolveMaxRememberedEvents(options);
  const issues: string[] = [];
  requireCondition(isRecord(value), "change event ingress checkpoint must be an object", issues);
  if (isRecord(value)) {
    requireExactFields(value, ["protocolVersion", "scope", "lastSequence", "lastEventMac", "remembered"], "change event ingress checkpoint", issues);
    requireCondition(value.protocolVersion === 1, "checkpoint.protocolVersion must be 1", issues);
    try {
      assertChangeEventScope(value.scope);
    } catch (error) {
      if (error instanceof ContractValidationError) issues.push(...error.issues);
      else throw error;
    }
    requireCondition(Number.isSafeInteger(value.lastSequence) && (value.lastSequence as number) >= 0, "checkpoint.lastSequence must be a non-negative integer", issues);
    requireCondition(
      value.lastEventMac === null || (typeof value.lastEventMac === "string" && HMAC_FINGERPRINT.test(value.lastEventMac)),
      "checkpoint.lastEventMac must be null or hmac-sha256:<64 lowercase hex>",
      issues,
    );
    requireCondition(
      ((value.lastSequence as number) === 0) === (value.lastEventMac === null),
      "checkpoint lastSequence and lastEventMac must be empty together",
      issues,
    );
    const remembered = value.remembered;
    requireCondition(Array.isArray(remembered), "checkpoint.remembered must be an array", issues);
    if (Array.isArray(remembered)) {
      requireCondition(remembered.length <= maxRememberedEvents, `checkpoint.remembered exceeds maxRememberedEvents (${maxRememberedEvents})`, issues);
      let previousSequence = 0;
      const eventIds = new Set<string>();
      const idempotencyKeys = new Set<string>();
      for (const [index, entry] of remembered.entries()) {
        requireCondition(isRecord(entry), `checkpoint.remembered[${index}] must be an object`, issues);
        if (!isRecord(entry)) continue;
        requireExactFields(entry, ["sequence", "eventId", "idempotencyKey", "integrityMac"], `checkpoint.remembered[${index}]`, issues);
        requireCondition(Number.isSafeInteger(entry.sequence) && (entry.sequence as number) > 0, `checkpoint.remembered[${index}].sequence must be a positive integer`, issues);
        collectSafeIdentifier(entry.eventId, `checkpoint.remembered[${index}].eventId`, issues);
        collectSafeIdentifier(entry.idempotencyKey, `checkpoint.remembered[${index}].idempotencyKey`, issues);
        requireCondition(typeof entry.integrityMac === "string" && HMAC_FINGERPRINT.test(entry.integrityMac), `checkpoint.remembered[${index}].integrityMac must be hmac-sha256:<64 lowercase hex>`, issues);
        if (Number.isSafeInteger(entry.sequence) && (entry.sequence as number) > 0) {
          requireCondition((entry.sequence as number) > previousSequence, "checkpoint.remembered sequences must be strictly ordered", issues);
          previousSequence = entry.sequence as number;
        }
        if (typeof entry.eventId === "string") {
          requireCondition(!eventIds.has(entry.eventId), "checkpoint.remembered event IDs must be unique", issues);
          eventIds.add(entry.eventId);
        }
        if (typeof entry.idempotencyKey === "string") {
          requireCondition(!idempotencyKeys.has(entry.idempotencyKey), "checkpoint.remembered idempotency keys must be unique", issues);
          idempotencyKeys.add(entry.idempotencyKey);
        }
      }
      if (remembered.length > 0 && Number.isSafeInteger(value.lastSequence) && (value.lastSequence as number) > 0) {
        const finalEntry = remembered.at(-1);
        if (isRecord(finalEntry)) {
          requireCondition(finalEntry.sequence === value.lastSequence, "checkpoint final remembered sequence must equal lastSequence", issues);
          requireCondition(finalEntry.integrityMac === value.lastEventMac, "checkpoint final remembered MAC must equal lastEventMac", issues);
        }
      }
      if ((value.lastSequence as number) > 0) {
        requireCondition(remembered.length > 0, "non-empty checkpoint must remember its latest event", issues);
      }
      if ((value.lastSequence as number) === 0) {
        requireCondition(remembered.length === 0, "empty checkpoint cannot remember events", issues);
      }
    }
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

/**
 * Validates an incoming stream for one exact view. This is intentionally
 * in-memory and side-effect free: the Bridge/API persists accepted events and
 * restores the latest sequence, MAC, event IDs, and idempotency keys on restart.
 */
export class ChangeEventIngress {
  readonly scope: ChangeEventScope;
  readonly maxRememberedEvents: number;
  #lastSequence = 0;
  #lastMac: string | null = null;
  #byEventId = new Map<string, RememberedIngressEvent>();
  #byIdempotencyKey = new Map<string, RememberedIngressEvent>();
  #remembered: ChangeEventIngressCheckpointEntry[] = [];

  constructor(scope: ChangeEventScope, options: ChangeEventIngressOptions = {}) {
    assertChangeEventScope(scope);
    this.scope = { ...scope };
    this.maxRememberedEvents = resolveMaxRememberedEvents(options);
  }

  static restore(
    scope: ChangeEventScope,
    checkpoint: unknown,
    options: ChangeEventIngressOptions = {},
  ): ChangeEventIngress {
    const ingress = new ChangeEventIngress(scope, options);
    assertChangeEventIngressCheckpoint(checkpoint, { maxRememberedEvents: ingress.maxRememberedEvents });
    for (const field of ["tenantId", "workspaceId", "changeId", "viewId"] as const) {
      if (checkpoint.scope[field] !== ingress.scope[field]) {
        throw new ContractValidationError([`checkpoint scope ${field} does not match requested ingress scope`]);
      }
    }
    ingress.#lastSequence = checkpoint.lastSequence;
    ingress.#lastMac = checkpoint.lastEventMac;
    for (const entry of checkpoint.remembered) ingress.#rememberEntry({ ...entry });
    return ingress;
  }

  checkpoint(): ChangeEventIngressCheckpoint {
    return {
      protocolVersion: 1,
      scope: { ...this.scope },
      lastSequence: this.#lastSequence,
      lastEventMac: this.#lastMac,
      remembered: this.#remembered.map((entry) => ({ ...entry })),
    };
  }

  receive(value: unknown): ChangeEventIngressResult {
    let event: ChangeEvent;
    try {
      assertChangeEvent(value);
      event = value;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Change event is invalid";
      return { status: "rejected", code: "invalid_event", message };
    }

    for (const [field, code] of [
      ["tenantId", "tenant_mismatch"],
      ["workspaceId", "workspace_mismatch"],
      ["changeId", "change_mismatch"],
      ["viewId", "view_mismatch"],
    ] as const) {
      if (event[field] !== this.scope[field]) {
        return { status: "rejected", code, message: `Event ${field} does not match this ingress scope` };
      }
    }

    const canonicalEvent = canonicalChangeEvent(event);
    const existingIdempotency = this.#byIdempotencyKey.get(event.idempotencyKey);
    if (existingIdempotency) {
      return this.#isExactRetry(existingIdempotency, event, canonicalEvent)
        ? { status: "duplicate", event: cloneEvent(event) }
        : { status: "rejected", code: "idempotency_key_reused", message: "Idempotency key was reused with a different event" };
    }
    const existingEvent = this.#byEventId.get(event.id);
    if (existingEvent) {
      return this.#isExactRetry(existingEvent, event, canonicalEvent)
        ? { status: "duplicate", event: cloneEvent(event) }
        : { status: "rejected", code: "event_id_reused", message: "Event ID was reused with a different event" };
    }

    const expectedSequence = this.#lastSequence + 1;
    if (event.sequence < expectedSequence) {
      return { status: "rejected", code: "sequence_replay", message: `Event sequence ${event.sequence} was already observed` };
    }
    if (event.sequence > expectedSequence) {
      return { status: "rejected", code: "sequence_gap", message: `Expected event sequence ${expectedSequence}, received ${event.sequence}` };
    }
    if (event.integrity.previousEventMac !== this.#lastMac) {
      return { status: "rejected", code: "integrity_chain_mismatch", message: "Event integrity chain does not match the accepted predecessor" };
    }

    const accepted = cloneEvent(event);
    this.#lastSequence = accepted.sequence;
    this.#lastMac = accepted.integrity.mac;
    this.#rememberEntry({
      sequence: accepted.sequence,
      eventId: accepted.id,
      idempotencyKey: accepted.idempotencyKey,
      integrityMac: accepted.integrity.mac,
    }, canonicalEvent);
    return { status: "accepted", event: accepted };
  }

  #isExactRetry(stored: RememberedIngressEvent, event: ChangeEvent, canonicalEvent: string): boolean {
    const { entry } = stored;
    if (entry.eventId !== event.id || entry.idempotencyKey !== event.idempotencyKey || entry.integrityMac !== event.integrity.mac) {
      return false;
    }
    // After restart only a verified HMAC is retained. The cryptographic verifier
    // must run before this guard receives the event; retaining the full event
    // solely for comparisons would needlessly persist encrypted references.
    return stored.canonicalEvent === undefined || stored.canonicalEvent === canonicalEvent;
  }

  #rememberEntry(entry: ChangeEventIngressCheckpointEntry, canonicalEvent?: string): void {
    this.#remembered.push(entry);
    const remembered: RememberedIngressEvent = canonicalEvent === undefined ? { entry } : { entry, canonicalEvent };
    this.#byEventId.set(entry.eventId, remembered);
    this.#byIdempotencyKey.set(entry.idempotencyKey, remembered);
    while (this.#remembered.length > this.maxRememberedEvents) {
      const evicted = this.#remembered.shift();
      if (!evicted) continue;
      if (this.#byEventId.get(evicted.eventId)?.entry.sequence === evicted.sequence) this.#byEventId.delete(evicted.eventId);
      if (this.#byIdempotencyKey.get(evicted.idempotencyKey)?.entry.sequence === evicted.sequence) this.#byIdempotencyKey.delete(evicted.idempotencyKey);
    }
  }
}

function resolveMaxRememberedEvents(options: ChangeEventIngressOptions): number {
  const value = options.maxRememberedEvents ?? 256;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_024) {
    throw new ContractValidationError(["maxRememberedEvents must be a safe integer between 1 and 1024"]);
  }
  return value;
}

/** Stable canonical representation used for duplicate/replay comparisons. */
export function canonicalChangeEvent(event: ChangeEvent): string {
  return canonicalJson(event);
}

/**
 * Canonical bytes to authenticate with the workspace's integrity key. The MAC
 * itself is intentionally omitted, while every scope, snapshot, actor,
 * private-object reference, path address, sequence, and predecessor binding is
 * protected. Callers must MAC these UTF-8 bytes with HMAC-SHA256 and write the
 * result as `hmac-sha256:<lowercase hex>` in `event.integrity.mac`.
 */
export function changeEventIntegrityPayload(event: ChangeEvent): string {
  const { mac: _mac, ...unsignedIntegrity } = event.integrity;
  return canonicalJson({ ...event, integrity: unsignedIntegrity });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`Unsupported change event value: ${typeof value}`);
}

function cloneEvent(event: ChangeEvent): ChangeEvent {
  return {
    ...event,
    actor: { ...event.actor },
    encryptedEvidenceObjectIds: [...event.encryptedEvidenceObjectIds],
    changedPathHashes: [...event.changedPathHashes],
    integrity: { ...event.integrity },
  };
}
