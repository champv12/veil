import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContractValidationError,
  assertRunnerIpcClientHello,
  assertRunnerIpcEvent,
  assertRunnerIpcRequest,
  assertRunnerIpcResponse,
  negotiateRunnerIpc,
  type RunnerIpcClientHello,
  type RunnerIpcRequest,
} from "../src/index.js";

const hello: RunnerIpcClientHello = {
  kind: "runner.hello",
  protocolVersions: [2, 1],
  capabilities: ["change", "run", "log", "capture", "evaluate", "cleanup", "workspace", "cancel", "publish"],
  client: { name: "veil-cli", version: "0.2.0" },
};

const runRequest: RunnerIpcRequest = {
  protocolVersion: 1,
  requestId: "request_01",
  idempotencyKey: "idem_01",
  operation: "run.start",
  payload: { changeId: "change_01", objective: "Fix the regression" },
};

test("Runner IPC negotiates the local protocol and capability intersection", () => {
  assert.doesNotThrow(() => assertRunnerIpcClientHello(hello));
  assert.deepEqual(
    negotiateRunnerIpc(hello, {
      id: "runner_01",
      version: "0.2.0",
      capabilities: ["change", "run", "log"],
      sessionId: "session_01",
    }),
    {
      ok: true,
      hello: {
        kind: "runner.hello_ack",
        protocolVersion: 1,
        capabilities: ["change", "run", "log"],
        runner: { id: "runner_01", version: "0.2.0" },
        sessionId: "session_01",
      },
    },
  );
});

test("Runner IPC rejects missing protocol and capability intersections", () => {
  const noVersion = negotiateRunnerIpc({ ...hello, protocolVersions: [2] }, {
    id: "runner_01", version: "0.2.0", capabilities: ["change"], sessionId: "session_01",
  });
  assert.equal(noVersion.ok, false);
  if (!noVersion.ok) assert.equal(noVersion.error.code, "UNSUPPORTED_PROTOCOL");

  const noCapabilities = negotiateRunnerIpc({ ...hello, capabilities: ["workspace"] }, {
    id: "runner_01", version: "0.2.0", capabilities: ["change"], sessionId: "session_01",
  });
  assert.equal(noCapabilities.ok, false);
  if (!noCapabilities.ok) assert.equal(noCapabilities.error.code, "UNSUPPORTED_CAPABILITY");
});

test("Runner IPC validates durable request, response, and resumable event envelopes", () => {
  assert.doesNotThrow(() => assertRunnerIpcRequest(runRequest));
  assert.doesNotThrow(() => assertRunnerIpcResponse({
    protocolVersion: 1,
    requestId: "request_01",
    idempotencyKey: "idem_01",
    operation: "run.start",
    operationId: "operation_01",
    status: "accepted",
    references: { changeId: "change_01", runId: "run_01" },
    cursor: "cursor:1",
    result: null,
  }));
  assert.doesNotThrow(() => assertRunnerIpcEvent({
    protocolVersion: 1,
    eventId: "event_01",
    operationId: "operation_01",
    sequence: 1,
    cursor: "cursor:1",
    type: "operation.accepted",
    occurredAt: "2026-07-19T10:00:00.000Z",
    references: { changeId: "change_01", runId: "run_01" },
    data: { state: "queued" },
  }));
});

test("Runner IPC validates lifecycle-specific inputs and structured failures", () => {
  assert.throws(
    () => assertRunnerIpcRequest({ ...runRequest, payload: { changeId: "change_01", objective: "Fix", agents: 2 } }),
    /unexpected field/,
  );
  assert.throws(
    () => assertRunnerIpcRequest({ ...runRequest, operation: "workspace.open", payload: { changeId: "change_01", launch: "terminal", path: "/private/work" } }),
    ContractValidationError,
  );
  assert.doesNotThrow(() => assertRunnerIpcResponse({
    protocolVersion: 1,
    requestId: "request_01",
    idempotencyKey: "idem_01",
    operation: "run.cancel",
    operationId: "operation_01",
    status: "failed",
    references: { runId: "run_01" },
    cursor: null,
    result: null,
    error: { code: "IDEMPOTENCY_CONFLICT", message: "Key belongs to another operation", retryable: false, details: { existingOperationId: "operation_00" } },
  }));
  assert.throws(
    () => assertRunnerIpcResponse({
      protocolVersion: 1, requestId: "request_01", idempotencyKey: "idem_01", operation: "run.cancel", operationId: "operation_01",
      status: "failed", references: { runId: "run_01" }, cursor: null, result: null,
    }),
    /error is required/,
  );
  assert.doesNotThrow(() => assertRunnerIpcRequest({
    ...runRequest,
    operation: "publish.create",
    payload: { changeId: "change_01", confirm: true, mode: "patch" },
  }));
  assert.doesNotThrow(() => assertRunnerIpcRequest({
    ...runRequest,
    operation: "publish.create",
    payload: {
      changeId: "change_01", confirm: true, mode: "patch",
      publicationIntentId: "intent_01", expectedCandidateId: "candidate_01", expectedPatchSha256: "a".repeat(64),
    },
  }));
  assert.throws(() => assertRunnerIpcRequest({
    ...runRequest,
    operation: "publish.create",
    payload: { changeId: "change_01", confirm: true, mode: "patch", publicationIntentId: "intent_01", expectedCandidateId: "candidate_01" },
  }), /exact publication binding must be complete/);
  assert.throws(() => assertRunnerIpcRequest({
    ...runRequest,
    operation: "publish.create",
    payload: { changeId: "change_01", confirm: true, mode: "patch", attestation: {} },
  }), /unexpected fields/);
  assert.doesNotThrow(() => assertRunnerIpcRequest({
    ...runRequest,
    operation: "change.create",
    payload: { title: "Local", description: "Local", repositoryUrl: "https://github.com/example/private", ref: "a".repeat(40), localRepository: { sourcePath: "/private/local/repo", baseCommit: "a".repeat(40) } },
  }));
  assert.doesNotThrow(() => assertRunnerIpcRequest({
    ...runRequest,
    operation: "change.update",
    payload: { changeId: "change_01", title: "Add profile validation" },
  }));
  assert.throws(() => assertRunnerIpcRequest({
    ...runRequest,
    operation: "change.update",
    payload: { changeId: "change_01", title: "  " },
  }), /title must be a non-empty string/);
  assert.throws(() => assertRunnerIpcRequest({
    ...runRequest,
    operation: "change.create",
    payload: { title: "Local", description: "Local", repositoryUrl: "https://github.com/example/private", localRepository: { sourcePath: "relative/repo", baseCommit: "a".repeat(40) } },
  }), /must be absolute/);
  assert.throws(() => assertRunnerIpcRequest({
    ...runRequest,
    operation: "unknown.operation",
    payload: { changeId: "change_01" },
  }), /operation is unsupported/);
  assert.throws(
    () => assertRunnerIpcRequest({
      ...runRequest,
      operation: "publish.create",
      payload: { changeId: "change_01", confirm: false },
    }),
    /confirm must be true/,
  );
});
