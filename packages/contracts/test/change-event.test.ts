import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChangeEventIngress,
  ContractValidationError,
  assertChangeEvent,
  assertChangeEventIngressCheckpoint,
  canonicalChangeEvent,
  changeEventIntegrityPayload,
  type ChangeEvent,
} from "../src/index.js";

const objectId = "a".repeat(64);
const evidenceObjectId = "b".repeat(64);
const pathHash = `hmac-sha256:${"c".repeat(64)}`;
const firstMac = `hmac-sha256:${"d".repeat(64)}`;
const secondMac = `hmac-sha256:${"e".repeat(64)}`;

const scope = {
  tenantId: "tenant_01",
  workspaceId: "workspace_01",
  changeId: "change_01",
  viewId: "view_01",
};

function event(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  const base: ChangeEvent = {
    protocolVersion: 1,
    id: "event_01",
    ...scope,
    idempotencyKey: "idem_01",
    sequence: 1,
    parentSnapshotId: "snapshot_parent",
    resultSnapshotId: "snapshot_result",
    actor: { type: "maintainer", identityId: "identity_01" },
    source: "manual-capture",
    encryptedContextObjectId: objectId,
    encryptedEvidenceObjectIds: [evidenceObjectId],
    changedPathHashes: [pathHash],
    integrity: {
      algorithm: "HMAC-SHA256",
      keyId: "integrity_key_01",
      previousEventMac: null,
      mac: firstMac,
    },
    createdAt: "2026-07-19T10:00:00.000Z",
  };
  return { ...base, ...overrides };
}

test("change event validator accepts private, complete provenance", () => {
  const value = event();
  assert.doesNotThrow(() => assertChangeEvent(value));
  assert.equal(canonicalChangeEvent(value), canonicalChangeEvent(JSON.parse(JSON.stringify(value))));
});

test("integrity payload is canonical and binds every protected event field", () => {
  const value = event();
  const payload = changeEventIntegrityPayload(value);
  assert.equal(payload.includes(value.integrity.mac), false, "the output MAC must not authenticate itself");
  assert.equal(
    payload,
    changeEventIntegrityPayload(JSON.parse(JSON.stringify(value))),
    "input object key order must not affect MAC input",
  );
  for (const tampered of [
    event({ tenantId: "tenant_other" }),
    event({ workspaceId: "workspace_other" }),
    event({ viewId: "view_other" }),
    event({ resultSnapshotId: "snapshot_tampered" }),
    event({ sequence: 2 }),
    event({ changedPathHashes: [`hmac-sha256:${"f".repeat(64)}`] }),
    event({ integrity: { ...value.integrity, previousEventMac: firstMac } }),
  ]) {
    assert.notEqual(changeEventIntegrityPayload(tampered), payload);
  }
});

test("change event validator rejects public paths, malformed object references, and altered bindings", () => {
  assert.throws(() => assertChangeEvent({ ...event(), changedPathHashes: ["src/private.ts"] }), ContractValidationError);
  assert.throws(() => assertChangeEvent({ ...event(), encryptedContextObjectId: "README.md" }), /private object ID/);
  assert.throws(() => assertChangeEvent({ ...event(), parentSnapshotId: "snapshot_result" }), /must differ/);
  assert.throws(() => assertChangeEvent({ ...event(), sequence: 0 }), /positive integer/);
  assert.throws(() => assertChangeEvent({ ...event(), tenantId: "tenant/other" }), /tenantId/);
  assert.throws(() => assertChangeEvent({ ...event(), unexpectedPlaintext: "do not accept me" }), /unexpected fields/);
  assert.throws(() => assertChangeEvent({ ...event(), integrity: { ...event().integrity, mac: "tampered" } }), /integrity.mac/);
  assert.throws(() => assertChangeEvent({ ...event(), encryptedEvidenceObjectIds: [evidenceObjectId, evidenceObjectId] }), /unique/);
});

test("ingress accepts one contiguous event and treats an exact retry as a duplicate", () => {
  const ingress = new ChangeEventIngress(scope);
  const first = event();
  assert.equal(ingress.receive(first).status, "accepted");
  const duplicate = ingress.receive(JSON.parse(JSON.stringify(first)));
  assert.equal(duplicate.status, "duplicate");
  if (duplicate.status === "duplicate") assert.equal(duplicate.event.id, first.id);
});

test("ingress rejects duplicate-key tampering, event-ID reuse, and sequence replay", () => {
  const ingress = new ChangeEventIngress(scope);
  assert.equal(ingress.receive(event()).status, "accepted");
  assert.deepEqual(
    ingress.receive(event({ resultSnapshotId: "snapshot_tampered" })),
    {
      status: "rejected",
      code: "idempotency_key_reused",
      message: "Idempotency key was reused with a different event",
    },
  );
  assert.equal(
    ingress.receive(event({ idempotencyKey: "idem_02" })).status,
    "rejected",
  );
  const replay = ingress.receive(event({ id: "event_02", idempotencyKey: "idem_03" }));
  assert.equal(replay.status, "rejected");
  if (replay.status === "rejected") assert.equal(replay.code, "sequence_replay");
});

test("ingress rejects gaps, integrity-chain tampering, and foreign scopes", () => {
  const ingress = new ChangeEventIngress(scope);
  const gap = ingress.receive(event({ sequence: 2, integrity: { ...event().integrity, previousEventMac: firstMac, mac: secondMac } }));
  assert.equal(gap.status, "rejected");
  if (gap.status === "rejected") assert.equal(gap.code, "sequence_gap");

  assert.equal(ingress.receive(event()).status, "accepted");
  const brokenChain = ingress.receive(event({
    id: "event_02",
    idempotencyKey: "idem_02",
    sequence: 2,
    resultSnapshotId: "snapshot_result_02",
    integrity: { ...event().integrity, previousEventMac: null, mac: secondMac },
  }));
  assert.equal(brokenChain.status, "rejected");
  if (brokenChain.status === "rejected") assert.equal(brokenChain.code, "integrity_chain_mismatch");

  for (const [field, expected] of [
    ["tenantId", "tenant_mismatch"],
    ["workspaceId", "workspace_mismatch"],
    ["changeId", "change_mismatch"],
    ["viewId", "view_mismatch"],
  ] as const) {
    const foreign = new ChangeEventIngress(scope).receive(event({ [field]: `${field}_other` }));
    assert.equal(foreign.status, "rejected");
    if (foreign.status === "rejected") assert.equal(foreign.code, expected);
  }
});

test("ingress checkpoints resume duplicate, idempotency, ordering, and integrity protections", () => {
  const ingress = new ChangeEventIngress(scope);
  const first = event();
  assert.equal(ingress.receive(first).status, "accepted");

  const checkpoint = JSON.parse(JSON.stringify(ingress.checkpoint()));
  assert.doesNotThrow(() => assertChangeEventIngressCheckpoint(checkpoint));
  assert.equal(JSON.stringify(checkpoint).includes(objectId), false, "checkpoint must not retain encrypted context references");
  assert.equal(JSON.stringify(checkpoint).includes(pathHash), false, "checkpoint must not retain path hashes");

  const restored = ChangeEventIngress.restore(scope, checkpoint);
  assert.equal(restored.receive(first).status, "duplicate");

  const alteredIdempotency = restored.receive(event({ idempotencyKey: "idem_02" }));
  assert.equal(alteredIdempotency.status, "rejected");
  if (alteredIdempotency.status === "rejected") assert.equal(alteredIdempotency.code, "event_id_reused");

  const alteredEvent = restored.receive(event({ id: "event_02" }));
  assert.equal(alteredEvent.status, "rejected");
  if (alteredEvent.status === "rejected") assert.equal(alteredEvent.code, "idempotency_key_reused");

  const next = event({
    id: "event_02",
    idempotencyKey: "idem_02",
    sequence: 2,
    resultSnapshotId: "snapshot_result_02",
    integrity: { ...first.integrity, previousEventMac: firstMac, mac: secondMac },
  });
  assert.equal(restored.receive(next).status, "accepted");
});

test("ingress checkpoint validation rejects malformed, foreign, and over-retained state", () => {
  const ingress = new ChangeEventIngress(scope, { maxRememberedEvents: 1 });
  const first = event();
  assert.equal(ingress.receive(first).status, "accepted");
  const checkpoint = ingress.checkpoint();

  assert.throws(
    () => assertChangeEventIngressCheckpoint({ ...checkpoint, lastEventMac: null }),
    /empty together/,
  );
  assert.throws(
    () => assertChangeEventIngressCheckpoint({ ...checkpoint, remembered: [] }),
    /must remember its latest event/,
  );
  assert.throws(
    () => ChangeEventIngress.restore({ ...scope, tenantId: "tenant_other" }, checkpoint),
    /scope tenantId/,
  );
  const remembered = checkpoint.remembered.at(0);
  assert.ok(remembered);
  assert.throws(
    () => assertChangeEventIngressCheckpoint({ ...checkpoint, remembered: [...checkpoint.remembered, { ...remembered, sequence: 2, eventId: "event_02", idempotencyKey: "idem_02", integrityMac: secondMac }] }, { maxRememberedEvents: 1 }),
    /exceeds/,
  );
});
