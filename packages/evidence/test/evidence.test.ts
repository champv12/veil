import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ChangeState } from "@veil/contracts";
import { generateKeyPairSync } from "node:crypto";
import {
  assertNoLeaks,
  buildEvidenceReport,
  redactJson,
  renderEvidenceMarkdown,
  scanTreeForLeaks,
  verifyEvidenceReport,
  signExactResultAttestation,
  verifyExactResultAttestation,
  buildStructuralSemanticReview,
  buildProgramFlowSemanticReview,
} from "../src/index.js";

test("builds an evidence-linked structural review with raw-diff fallback", () => {
  const sanitizedDiff = [
    "diff --git a/src/profile.ts b/src/profile.ts",
    "index 1111111..2222222 100644",
    "--- a/src/profile.ts",
    "+++ b/src/profile.ts",
    "@@ -8,2 +8,6 @@",
    " export function saveProfile(name: string) {",
    "+  if (!name.trim()) throw new Error('Profile name is required');",
    "   return repository.save(name);",
    " }",
    "",
  ].join("\n");

  const review = buildStructuralSemanticReview({
    workspaceTreeId: `sha256:${"1".repeat(64)}`,
    sanitizedDiff,
    verification: [{ checkId: "test", result: "passed" }],
  });

  assert.equal(review.artifact.analysis.engine, "veil-structural");
  assert.equal(review.artifact.sections[0]?.title, "saveProfile");
  assert.equal(review.artifact.sections[0]?.kind, "behavior");
  assert.deepEqual(review.artifact.sections[0]?.evidence[0], {
    kind: "diff-hunk",
    path: "src/profile.ts",
    oldStart: 8,
    oldLines: 2,
    newStart: 8,
    newLines: 6,
  });
  assert.equal(review.artifact.sections.at(-1)?.kind, "test");
  assert.match(review.id, /^sha256:[0-9a-f]{64}$/);
});

test("structural review keeps deleted files, binary changes, renames, and later hunks on their own paths", () => {
  const sanitizedDiff = [
    "diff --git a/src/keep.ts b/src/keep.ts",
    "--- a/src/keep.ts",
    "+++ b/src/keep.ts",
    "@@ -1 +1,2 @@",
    " export const keep = true;",
    "+export const added = true;",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-export function gone() {}",
    "-gone();",
    "diff --git a/assets/logo.png b/assets/logo.png",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/assets/logo.png",
    "Binary files /dev/null and b/assets/logo.png differ",
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 100%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
    "diff --git a/src/final.ts b/src/final.ts",
    "--- a/src/final.ts",
    "+++ b/src/final.ts",
    "@@ -2 +2 @@",
    "-oldCall();",
    "+newCall();",
    "",
  ].join("\n");
  const review = buildStructuralSemanticReview({
    workspaceTreeId: `sha256:${"2".repeat(64)}`,
    sanitizedDiff,
  });
  assert.deepEqual(review.artifact.sections.map(({ kind, title }) => ({ kind, title })), [
    { kind: "behavior", title: "keep" },
    { kind: "deletion", title: "src/gone.ts" },
    { kind: "binary", title: "assets/logo.png" },
    { kind: "other", title: "src/new-name.ts" },
    { kind: "behavior", title: "newCall" },
  ]);
  assert.equal((review.artifact.sections[1]?.evidence[0] as { path: string }).path, "src/gone.ts");
  assert.equal((review.artifact.sections[2]?.evidence[0] as { path: string }).path, "assets/logo.png");
  assert.equal((review.artifact.sections[3]?.evidence[0] as { path: string }).path, "src/new-name.ts");
  assert.equal((review.artifact.sections[4]?.evidence[0] as { path: string }).path, "src/final.ts");
});

test("structural review represents binary additions, replacements, and deletions", () => {
  const sanitizedDiff = [
    "diff --git a/new.bin b/new.bin", "--- /dev/null", "+++ b/new.bin", "Binary files /dev/null and b/new.bin differ",
    "diff --git a/changed.bin b/changed.bin", "--- a/changed.bin", "+++ b/changed.bin", "Binary files a/changed.bin and b/changed.bin differ",
    "diff --git a/old.bin b/old.bin", "--- a/old.bin", "+++ /dev/null", "Binary files a/old.bin and /dev/null differ", "",
  ].join("\n");
  const review = buildStructuralSemanticReview({ workspaceTreeId: `sha256:${"3".repeat(64)}`, sanitizedDiff });
  assert.deepEqual(review.artifact.sections.map(({ kind, title }) => ({ kind, title })), [
    { kind: "binary", title: "new.bin" },
    { kind: "binary", title: "changed.bin" },
    { kind: "binary", title: "old.bin" },
  ]);
});

test("TypeScript flow review links calls, data movement, and transitive impact to exact source", () => {
  const sanitizedDiff = [
    "diff --git a/src/profile.ts b/src/profile.ts",
    "--- a/src/profile.ts",
    "+++ b/src/profile.ts",
    "@@ -3,4 +3,5 @@",
    " export function saveProfile(name: string) {",
    "+  if (!name.trim()) throw new Error('Profile name is required');",
    "   const normalized = normalizeProfile(name);",
    "   return saveRecord(normalized);",
    " }",
  ].join("\n");
  const review = buildProgramFlowSemanticReview({
    workspaceTreeId: `sha256:${"4".repeat(64)}`,
    sanitizedDiff,
    sources: [
      { path: "src/repository.ts", content: "export function saveRecord(value: string) { return value; }\n" },
      { path: "src/profile.ts", content: [
        "import { saveRecord } from './repository.js';",
        "export function normalizeProfile(name: string) { return name.trim(); }",
        "export function saveProfile(name: string) {",
        "  if (!name.trim()) throw new Error('Profile name is required');",
        "  const normalized = normalizeProfile(name);",
        "  return saveRecord(normalized);",
        "}",
      ].join("\n") },
      { path: "src/handler.ts", content: [
        "import { saveProfile } from './profile.js';",
        "export function handleProfile(name: string) {",
        "  return saveProfile(name);",
        "}",
      ].join("\n") },
    ],
  });

  assert.equal(review.artifact.analysis.engine, "veil-typescript-flow");
  assert.equal(review.artifact.impact?.coverage.callFlow, "partial");
  assert.equal(review.artifact.impact?.coverage.dataFlow, "partial");
  assert.match(review.artifact.impact?.coverage.reasons.join(" ") ?? "", /Unresolved call/);
  assert.equal(review.artifact.impact?.relationships.some((edge) => edge.kind === "call" && edge.from.symbol === "saveProfile" && edge.to.symbol === "normalizeProfile"), true);
  assert.equal(review.artifact.impact?.relationships.some((edge) => edge.kind === "call" && edge.from.symbol === "saveProfile" && edge.to.symbol === "saveRecord"), true);
  assert.equal(review.artifact.impact?.relationships.some((edge) => edge.kind === "data-flow" && edge.to.symbol === "saveRecord"), true);
  assert.equal(review.artifact.impact?.impactedSymbols.some((symbol) => symbol.symbol === "handleProfile"), true);
  assert.equal(review.artifact.impact?.relationships.every((edge) => edge.evidence.length > 0), true);
});

test("program-flow review reports unsupported languages instead of inventing coverage", () => {
  const review = buildProgramFlowSemanticReview({
    workspaceTreeId: `sha256:${"5".repeat(64)}`,
    sanitizedDiff: "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-print('old')\n+print('new')\n",
    sources: [{ path: "app.py", content: "print('new')\n" }],
  });
  assert.equal(review.artifact.impact?.coverage.callFlow, "unsupported");
  assert.match(review.artifact.impact?.coverage.reasons[0] ?? "", /TypeScript and JavaScript/);
});

test("redaction removes paths, explicit secrets, and sensitive-key values", () => {
  const root = path.join(os.tmpdir(), "private-run");
  const result = redactJson({
    message: `failed at ${root}/agent-a with SENTINEL`,
    accessToken: "token-value",
    nested: ["SENTINEL"],
  }, { secrets: ["SENTINEL"], paths: [{ path: root, replacement: "<run>" }] });
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes("SENTINEL"), false);
  assert.equal(encoded.includes(root), false);
  assert.equal(encoded.includes("token-value"), false);
});

test("hash-backed reports verify and expose tampering", () => {
  const report = buildEvidenceReport({
    version: 1,
    reportId: "report_test",
    changeId: "change_test",
    generatedAt: "2026-07-18T00:00:00.000Z",
    state: ChangeState.ReviewReady,
    baseCommit: "a".repeat(40),
    selectedCandidateId: "result_a",
    candidates: [{ candidateId: "result_a", snapshotId: "snapshot_a", passed: true, changedFiles: 1, insertions: 4, deletions: 1, patchSha256: "b".repeat(64) }],
    gates: [{ name: "Privacy", status: "pass", evidence: "No sentinel detected" }],
    auditHeadHash: "c".repeat(64),
    publication: null,
    boundaries: ["Logical deletion is not forensic erasure."],
    metadata: { privateKey: "must disappear", runtime: "node" },
  });
  assert.equal(verifyEvidenceReport(report), true);
  assert.equal(JSON.stringify(report).includes("must disappear"), false);
  const markdown = renderEvidenceMarkdown(report);
  assert.match(markdown, /Payload SHA-256/);
  assert.match(markdown, /Current private result/);
  assert.doesNotMatch(markdown, /candidate/i);
  const tampered = structuredClone(report);
  tampered.payload.baseCommit = "changed";
  assert.equal(verifyEvidenceReport(tampered), false);
});

test("signed exact-result attestations bind result, gates, recipe, and publication expiry", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = new Date("2026-07-21T10:00:00.000Z");
  const signed = signExactResultAttestation({
    version: 1,
    attestationId: "attestation_test",
    issuer: "veil-local",
    issuedAt: now.toISOString(),
    repositoryUrl: "https://github.com/example/private-repo",
    baseCommit: "a".repeat(40),
    patchSha256: "b".repeat(64),
    recipeSha256: "c".repeat(64),
    toolVersion: "0.2.1",
    gates: [{ name: "private-security-suite", status: "passed", evidenceSha256: "d".repeat(64) }],
    publicationIntent: { intentId: "intent_test", mode: "draft_pull_request", branchName: "veil/fix", expiresAt: "2026-07-21T10:05:00.000Z" },
  }, { keyId: "test:key-1", privateKey, now });
  assert.equal(verifyExactResultAttestation(signed, publicKey, { now }), true);
  const wrongKey = generateKeyPairSync("ed25519").publicKey;
  assert.equal(verifyExactResultAttestation(signed, wrongKey, { now }), false);
  assert.equal(verifyExactResultAttestation(signed, publicKey, { now: new Date("2026-07-21T10:06:00.000Z") }), false);
  const receipt = signExactResultAttestation({
    ...signed.payload,
    attestationId: "receipt_test",
    publicationReceipt: {
      publishedAt: "2026-07-21T10:04:00.000Z",
      commitSha: "e".repeat(40),
      draftPullRequestUrl: "https://github.com/example/private-repo/pull/7",
    },
  }, { keyId: "test:key-1", privateKey, now: new Date("2026-07-21T10:04:00.000Z") });
  assert.equal(verifyExactResultAttestation(receipt, publicKey, { now: new Date("2027-07-21T10:00:00.000Z") }), true);
  const lateReceipt = structuredClone(receipt);
  lateReceipt.payload.publicationReceipt!.publishedAt = "2026-07-21T10:06:00.000Z";
  assert.equal(verifyExactResultAttestation(lateReceipt, publicKey, { allowExpired: true }), false);
  const changedPatch = structuredClone(signed);
  changedPatch.payload.patchSha256 = "e".repeat(64);
  assert.equal(verifyExactResultAttestation(changedPatch, publicKey, { now }), false);
  const changedBranch = structuredClone(signed);
  changedBranch.payload.publicationIntent.branchName = "veil/other";
  assert.equal(verifyExactResultAttestation(changedBranch, publicKey, { now }), false);
  const changedGate = structuredClone(signed);
  changedGate.payload.gates[0]!.status = "failed";
  assert.equal(verifyExactResultAttestation(changedGate, publicKey, { now }), false);
  const malformedSignature = structuredClone(signed);
  malformedSignature.signature = Buffer.alloc(63).toString("base64");
  assert.equal(verifyExactResultAttestation(malformedSignature, publicKey, { now }), false);
});

test("legacy multi-result evidence renders only the current private result", () => {
  const report = buildEvidenceReport({
    version: 1,
    reportId: "report_legacy",
    changeId: "change_test",
    generatedAt: "2026-07-18T00:00:00.000Z",
    state: ChangeState.ReviewReady,
    baseCommit: "a".repeat(40),
    selectedCandidateId: "result_current",
    candidates: [{ candidateId: "result_current", snapshotId: "snapshot_current", passed: true, changedFiles: 1, insertions: 1, deletions: 0, patchSha256: "b".repeat(64) }],
    gates: [], auditHeadHash: null, publication: null, boundaries: [], metadata: {},
  });
  report.payload.candidates.unshift({ candidateId: "result_old", snapshotId: "snapshot_old", passed: false, changedFiles: 2, insertions: 2, deletions: 2, patchSha256: null });
  const markdown = renderEvidenceMarkdown(report);
  assert.match(markdown, /result_current/);
  assert.doesNotMatch(markdown, /result_old/);
});

test("new evidence reports reject multiple private results", () => {
  assert.throws(() => buildEvidenceReport({
    version: 1,
    reportId: "report_multiple",
    changeId: "change_test",
    generatedAt: "2026-07-18T00:00:00.000Z",
    state: ChangeState.ReviewReady,
    baseCommit: "a".repeat(40),
    selectedCandidateId: null,
    candidates: [
      { candidateId: "result_one", snapshotId: "snapshot_one", passed: true, changedFiles: 1, insertions: 1, deletions: 0, patchSha256: null },
      { candidateId: "result_two", snapshotId: "snapshot_two", passed: true, changedFiles: 1, insertions: 1, deletions: 0, patchSha256: null },
    ],
    gates: [], auditHeadHash: null, publication: null, boundaries: [], metadata: {},
  }), /one current private result/);
});

test("leak scan reports content without copying it into findings and flags symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-leaks-"));
  try {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "safe.txt"), "nothing here");
    await writeFile(path.join(root, "leak.txt"), "prefix UNIQUE-SENTINEL suffix");
    await symlink("leak.txt", path.join(root, "link"));
    const result = await scanTreeForLeaks({ root, needles: [{ label: "confidential brief sentinel", value: "UNIQUE-SENTINEL" }] });
    assert.equal(result.passed, false);
    assert.equal(result.findings.length, 2);
    assert.equal(JSON.stringify(result).includes("UNIQUE-SENTINEL"), false);
    assert.throws(() => assertNoLeaks(result), /confidential brief sentinel/);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});
