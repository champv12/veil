import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChangeState,
  ContractValidationError,
  assertPrivateChange,
  assertPublicationPolicy,
  assertStartRunRequest,
  parseJson,
  type PrivateChange,
} from "../src/index.js";

const change: PrivateChange = {
  id: "change_1",
  title: "Confidential fix",
  description: "Repair traversal",
  base: {
    repositoryUrl: "https://github.com/example/repo",
    owner: "example",
    repository: "repo",
    defaultBranch: "main",
    baseCommit: "a".repeat(40),
    importedAt: "2026-07-18T00:00:00.000Z",
  },
  ownerIdentityId: "maintainer",
  state: ChangeState.PrivateReady,
  rootSnapshotId: null,
  selectedCandidateId: null,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

test("private change and JSON parser accept a valid wire value", () => {
  assert.doesNotThrow(() => assertPrivateChange(change));
  assert.deepEqual(parseJson(JSON.stringify(change), assertPrivateChange), change);
});

test("validators reject malformed state and publication branches", () => {
  assert.throws(
    () => assertPrivateChange({ ...change, state: "READYISH" }),
    ContractValidationError,
  );
  assert.doesNotThrow(() => assertStartRunRequest({ instructions: "fix" }));
  assert.throws(
    () => assertPublicationPolicy({
      mode: "git_patch",
      branchName: "bad..branch",
      requireExplicitConfirmation: true,
      openAsDraft: false,
      stripPrivatePaths: [".veil-private/**"],
      requirePassingVerification: true,
    }),
    /branchName/,
  );
});
