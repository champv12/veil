import assert from "node:assert/strict";
import test from "node:test";
import { identifySemanticReview } from "../src/index.js";

const digest = (character: string) => character.repeat(64);

test("identifies a portable Semantic Review through exact source and evidence", () => {
  const review = identifySemanticReview({
    schemaVersion: 1,
    workspaceTreeId: `sha256:${digest("1")}`,
    rawDiff: {
      mediaType: "text/x-diff",
      sha256: digest("2"),
    },
    analysis: {
      engine: "veil-structural",
      version: "1.0.0",
      deterministic: true,
    },
    overview: {
      summary: "Adds validation before a saved profile is updated.",
      certainty: "observed",
      evidence: [{
        kind: "diff-hunk",
        path: "src/profile.ts",
        oldStart: 8,
        oldLines: 2,
        newStart: 8,
        newLines: 6,
      }],
    },
    sections: [{
      id: "profile-validation",
      kind: "behavior",
      title: "Profile validation",
      summary: "Invalid profile names now stop before persistence.",
      certainty: "inferred",
      evidence: [{
        kind: "source-range",
        path: "src/profile.ts",
        startLine: 8,
        endLine: 14,
        symbol: "saveProfile",
      }],
    }],
  });

  assert.match(review.id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(review.artifact.sections[0]?.id, "profile-validation");
  assert.equal(review.artifact.rawDiff.sha256, digest("2"));
});

test("rejects a Semantic Review when its exact source or raw diff is stale", () => {
  const artifact = {
    schemaVersion: 1,
    workspaceTreeId: `sha256:${digest("1")}`,
    rawDiff: { mediaType: "text/x-diff", sha256: digest("2") },
    analysis: { engine: "veil-structural", version: "1.0.0", deterministic: true },
    overview: { summary: "No supported behavioral analysis is available.", certainty: "unsupported", evidence: [] },
    sections: [],
  };

  assert.throws(
    () => identifySemanticReview(artifact, {
      workspaceTreeId: `sha256:${digest("3")}`,
      rawDiffSha256: digest("2"),
    }),
    /semantic review is stale for the requested Workspace Tree ID/,
  );
  assert.throws(
    () => identifySemanticReview(artifact, {
      workspaceTreeId: `sha256:${digest("1")}`,
      rawDiffSha256: digest("4"),
    }),
    /semantic review is stale for the requested raw diff/,
  );
});

test("rejects unknown review fields and claims without exact evidence", () => {
  const artifact = {
    schemaVersion: 1,
    workspaceTreeId: `sha256:${digest("1")}`,
    rawDiff: { mediaType: "text/x-diff", sha256: digest("2") },
    analysis: { engine: "veil-structural", version: "1.0.0", deterministic: true },
    overview: {
      summary: "Claims a behavior without support.",
      certainty: "observed",
      evidence: [],
    },
    sections: [],
    branch: "main",
  };

  assert.throws(
    () => identifySemanticReview(artifact),
    /semantic review artifact contains unknown fields: branch/,
  );
  delete (artifact as { branch?: string }).branch;
  assert.throws(
    () => identifySemanticReview(artifact),
    /semantic review overview must reference evidence when it is observed/,
  );
});

test("rejects unsafe or inexact evidence references", () => {
  const artifact = {
    schemaVersion: 1,
    workspaceTreeId: `sha256:${digest("1")}`,
    rawDiff: { mediaType: "text/x-diff", sha256: digest("2") },
    analysis: { engine: "veil-structural", version: "1.0.0", deterministic: true },
    overview: {
      summary: "Changes a profile.",
      certainty: "observed",
      evidence: [{
        kind: "diff-hunk",
        path: "../private/profile.ts",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
      }],
    },
    sections: [],
  };

  assert.throws(
    () => identifySemanticReview(artifact),
    /semantic review overview evidence\[0\] path is unsafe/,
  );
});

test("rejects malformed source bindings and unsupported section fields", () => {
  const artifact = {
    schemaVersion: 1,
    workspaceTreeId: "commit:abc",
    rawDiff: { mediaType: "text/x-diff", sha256: digest("2") },
    analysis: { engine: "veil-structural", version: "1.0.0", deterministic: true },
    overview: { summary: "No supported analysis.", certainty: "unsupported", evidence: [] },
    sections: [],
  };
  assert.throws(() => identifySemanticReview(artifact), /Workspace Tree ID is invalid/);
  artifact.workspaceTreeId = `sha256:${digest("1")}`;
  artifact.rawDiff.sha256 = "not-a-digest";
  assert.throws(() => identifySemanticReview(artifact), /raw diff SHA-256 is invalid/);

  artifact.rawDiff.sha256 = digest("2");
  (artifact.sections as unknown[]).push({
    id: "behavior-1",
    kind: "behavior",
    title: "Behavior",
    summary: "Changes behavior.",
    certainty: "observed",
    evidence: [{ kind: "verification", checkId: "test", result: "passed" }],
    branch: "main",
  });
  assert.throws(
    () => identifySemanticReview(artifact),
    /semantic review sections\[0\] contains unknown fields: branch/,
  );
});

test("portable Semantic Review carries evidence-bound call, data-flow, and impact analysis", () => {
  const evidence = { kind: "source-range", path: "src/profile.ts", startLine: 8, endLine: 12, symbol: "saveProfile" };
  const review = identifySemanticReview({
    schemaVersion: 1,
    workspaceTreeId: `sha256:${digest("1")}`,
    rawDiff: { mediaType: "text/x-diff", sha256: digest("2") },
    analysis: { engine: "veil-typescript-flow", version: "1.0.0", deterministic: true },
    overview: { summary: "Profile validation affects persistence.", certainty: "observed", evidence: [evidence] },
    sections: [],
    impact: {
      coverage: { callFlow: "complete", dataFlow: "complete", reasons: [] },
      relationships: [{
        id: "call-save-profile-save-record",
        kind: "call",
        from: { path: "src/profile.ts", symbol: "saveProfile", startLine: 8, endLine: 12 },
        to: { path: "src/repository.ts", symbol: "saveRecord", startLine: 2, endLine: 4 },
        certainty: "observed",
        evidence: [evidence],
      }],
      impactedSymbols: [{ path: "src/handler.ts", symbol: "handleProfile", startLine: 4, endLine: 7 }],
      risk: "medium",
    },
  });
  assert.equal(review.artifact.impact?.coverage.callFlow, "complete");
  assert.equal(review.artifact.impact?.relationships[0]?.kind, "call");
});

test("impact claims fail closed without exact evidence or honest coverage", () => {
  const artifact = {
    schemaVersion: 1,
    workspaceTreeId: `sha256:${digest("1")}`,
    rawDiff: { mediaType: "text/x-diff", sha256: digest("2") },
    analysis: { engine: "veil-typescript-flow", version: "1.0.0", deterministic: true },
    overview: { summary: "No supported analysis.", certainty: "unsupported", evidence: [] },
    sections: [],
    impact: {
      coverage: { callFlow: "complete", dataFlow: "unsupported", reasons: ["Data flow is unsupported for this source language."] },
      relationships: [{
        id: "call-a-b",
        kind: "call",
        from: { path: "src/a.ts", symbol: "a" },
        to: { path: "src/b.ts", symbol: "b" },
        certainty: "observed",
        evidence: [],
      }],
      impactedSymbols: [],
      risk: "unknown",
    },
  };
  assert.throws(() => identifySemanticReview(artifact), /impact relationship\[0\] must reference exact evidence/);
  artifact.impact.relationships = [];
  artifact.impact.coverage.reasons = [];
  assert.throws(() => identifySemanticReview(artifact), /unsupported impact coverage requires a reason/);
});
