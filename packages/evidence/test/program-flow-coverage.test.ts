import assert from "node:assert/strict";
import test from "node:test";
import { buildProgramFlowSemanticReview } from "../src/index.js";

const workspaceTreeId = `sha256:${"7".repeat(64)}` as const;

function reviewSource(content: string, omittedSources?: string[]) {
  return buildProgramFlowSemanticReview({
    workspaceTreeId,
    sanitizedDiff: [
      "diff --git a/src/flow.ts b/src/flow.ts",
      "--- a/src/flow.ts",
      "+++ b/src/flow.ts",
      "@@ -1,0 +1,20 @@",
      ...content.split("\n").map((line) => `+${line}`),
    ].join("\n"),
    sources: [{ path: "src/flow.ts", content }],
    ...(omittedSources ? { omittedSources } : {}),
  }).artifact.impact!;
}

test("parameter flow prevents a complete program-flow claim", () => {
  const impact = reviewSource("export function consume(value: string) {}\n");
  assert.equal(impact.coverage.callFlow, "partial");
  assert.equal(impact.coverage.dataFlow, "partial");
  assert.match(impact.coverage.reasons.join(" "), /parameter flow/i);
});

test("unsupported ordinary JavaScript and TypeScript flows carry explicit coverage reasons", () => {
  const fixtures = [
    { name: "assignment", source: "export function work() { let value = 1; value = 2; }\n", reason: /assignment flow/i },
    { name: "return", source: "export function work() { return 1; }\n", reason: /return-value flow/i },
    { name: "destructuring", source: "export function work() { const { value } = { value: 1 }; }\n", reason: /destructuring flow/i },
    { name: "member call", source: "export function work() { service.save(); }\n", reason: /member-call flow/i },
    { name: "inline callback", source: "export function work() { run(() => 1); }\n", reason: /callback flow/i },
    { name: "named callback", source: "function callback() {}\nexport function work() { run(callback); }\n", reason: /callback flow/i },
    { name: "alias", source: "function target() {}\nexport function work() { const alias = target; alias(); }\n", reason: /alias flow/i },
  ];
  for (const fixture of fixtures) {
    const impact = reviewSource(fixture.source);
    assert.equal(impact.coverage.callFlow, "partial", `${fixture.name} call flow`);
    assert.equal(impact.coverage.dataFlow, "partial", `${fixture.name} data flow`);
    assert.match(impact.coverage.reasons.join(" "), fixture.reason, fixture.name);
  }
});

test("parse diagnostics and analysis-size omissions cannot produce complete coverage", () => {
  const parsed = reviewSource("export function broken( {\n");
  assert.equal(parsed.coverage.callFlow, "partial");
  assert.equal(parsed.coverage.dataFlow, "partial");
  assert.match(parsed.coverage.reasons.join(" "), /Parse diagnostics in src\/flow\.ts/);

  const omitted = reviewSource("export function modeled() {}\n", ["src/too-large.ts"]);
  assert.equal(omitted.coverage.callFlow, "partial");
  assert.equal(omitted.coverage.dataFlow, "partial");
  assert.match(omitted.coverage.reasons.join(" "), /Source omitted by analysis limits: src\/too-large\.ts/);
});

test("the defensible direct-call subset remains complete with exact call evidence", () => {
  const impact = reviewSource("function target() {}\nexport function caller() { target(); }\n");
  assert.equal(impact.coverage.callFlow, "complete");
  assert.equal(impact.coverage.dataFlow, "complete");
  const call = impact.relationships.find((relationship) => relationship.kind === "call");
  assert.deepEqual(call?.evidence, [{ kind: "source-range", path: "src/flow.ts", symbol: "caller", startLine: 2, endLine: 2 }]);
});

test("every changed range must overlap an analyzable declaration before coverage can be complete", () => {
  const content = [
    "function target() {}",
    "export function caller() { target(); }",
    "export const changedConfiguration = true;",
  ].join("\n");
  const impact = buildProgramFlowSemanticReview({
    workspaceTreeId,
    sanitizedDiff: [
      "diff --git a/src/flow.ts b/src/flow.ts",
      "--- a/src/flow.ts",
      "+++ b/src/flow.ts",
      "@@ -2 +2 @@",
      "-export function caller() {}",
      "+export function caller() { target(); }",
      "@@ -3,0 +3 @@",
      "+export const changedConfiguration = true;",
    ].join("\n"),
    sources: [{ path: "src/flow.ts", content }],
  }).artifact.impact!;

  assert.equal(impact.coverage.callFlow, "partial");
  assert.equal(impact.coverage.dataFlow, "partial");
  assert.match(impact.coverage.reasons.join(" "), /changed range outside analyzable declarations: src\/flow\.ts:3/i);
});

test("member calls never resolve to an unrelated method by bare property name", () => {
  const impact = buildProgramFlowSemanticReview({
    workspaceTreeId,
    sanitizedDiff: [
      "diff --git a/src/service.ts b/src/service.ts",
      "--- a/src/service.ts",
      "+++ b/src/service.ts",
      "@@ -1 +1 @@",
      "-export function persist() {}",
      "+export function persist() { service.save(); }",
    ].join("\n"),
    sources: [
      { path: "src/service.ts", content: "export function persist() { service.save(); }\n" },
      { path: "src/unrelated.ts", content: "export class Unrelated { save() {} }\n" },
    ],
  }).artifact.impact!;

  assert.equal(impact.coverage.callFlow, "partial");
  assert.match(impact.coverage.reasons.join(" "), /member-call flow|unresolved call/i);
  assert.equal(impact.relationships.some((relationship) => relationship.kind === "call" && relationship.from.symbol === "persist" && relationship.to.symbol === "save"), false);
});

test("direct calls resolve by lexical scope when a class method has the same name", () => {
  const impact = buildProgramFlowSemanticReview({
    workspaceTreeId,
    sanitizedDiff: [
      "diff --git a/src/storage.ts b/src/storage.ts",
      "--- a/src/storage.ts",
      "+++ b/src/storage.ts",
      "@@ -3 +3 @@",
      "-export function persist() {}",
      "+export function persist() { save(); }",
    ].join("\n"),
    sources: [{
      path: "src/storage.ts",
      content: [
        "export function save() {}",
        "export class Unrelated { save() {} }",
        "export function persist() { save(); }",
      ].join("\n"),
    }],
  }).artifact.impact!;

  assert.equal(impact.coverage.callFlow, "complete");
  const call = impact.relationships.find((relationship) => relationship.kind === "call" && relationship.from.symbol === "persist");
  assert.deepEqual(call?.to, { path: "src/storage.ts", symbol: "save", startLine: 1, endLine: 1 });
});

test("ambiguous same-scope callable declarations remain unresolved", () => {
  const impact = buildProgramFlowSemanticReview({
    workspaceTreeId,
    sanitizedDiff: [
      "diff --git a/src/storage.ts b/src/storage.ts",
      "--- a/src/storage.ts",
      "+++ b/src/storage.ts",
      "@@ -3 +3 @@",
      "-export function persist() {}",
      "+export function persist() { save(); }",
    ].join("\n"),
    sources: [{
      path: "src/storage.ts",
      content: [
        "const save = () => {};",
        "const save = function () {};",
        "export function persist() { save(); }",
      ].join("\n"),
    }],
  }).artifact.impact!;

  assert.equal(impact.coverage.callFlow, "partial");
  assert.match(impact.coverage.reasons.join(" "), /unresolved call/i);
  assert.equal(impact.relationships.some((relationship) => relationship.kind === "call" && relationship.from.symbol === "persist"), false);
});

test("a nested same-name declaration prevents a top-level call claim", () => {
  const impact = reviewSource([
    "function save() {}",
    "export function persist() {",
    "  function save() {}",
    "  save();",
    "}",
  ].join("\n"));

  assert.equal(impact.coverage.callFlow, "partial");
  assert.match(impact.coverage.reasons.join(" "), /unresolved call/i);
  assert.equal(impact.relationships.some((relationship) => relationship.kind === "call" && relationship.from.symbol === "persist"), false);
});

test("a callable parameter shadow prevents a top-level call claim", () => {
  const impact = buildProgramFlowSemanticReview({
    workspaceTreeId,
    sanitizedDiff: [
      "diff --git a/src/storage.ts b/src/storage.ts",
      "--- a/src/storage.ts",
      "+++ b/src/storage.ts",
      "@@ -2 +2 @@",
      "-export function persist(save: () => void) {}",
      "+export function persist(save: () => void) { save(); }",
    ].join("\n"),
    sources: [{
      path: "src/storage.ts",
      content: [
        "function save() {}",
        "export function persist(save: () => void) { save(); }",
      ].join("\n"),
    }],
  }).artifact.impact!;

  assert.equal(impact.coverage.callFlow, "partial");
  assert.match(impact.coverage.reasons.join(" "), /unresolved call/i);
  assert.equal(impact.relationships.some((relationship) => relationship.kind === "call" && relationship.from.symbol === "persist"), false);
});

test("a callable local binding shadow prevents a top-level call claim", () => {
  const impact = reviewSource([
    "function save() {}",
    "export function persist(injected: () => void) {",
    "  const save: () => void = injected;",
    "  save();",
    "}",
  ].join("\n"));

  assert.equal(impact.coverage.callFlow, "partial");
  assert.match(impact.coverage.reasons.join(" "), /unresolved call/i);
  assert.equal(impact.relationships.some((relationship) => relationship.kind === "call" && relationship.from.symbol === "persist"), false);
});

test("a parameter shadow prevents resolving through a same-named namespace import", () => {
  const impact = buildProgramFlowSemanticReview({
    workspaceTreeId,
    sanitizedDiff: [
      "diff --git a/src/caller.ts b/src/caller.ts",
      "--- a/src/caller.ts",
      "+++ b/src/caller.ts",
      "@@ -2 +2 @@",
      "-export function persist(ns: { save(): void }) {}",
      "+export function persist(ns: { save(): void }) { ns.save(); }",
    ].join("\n"),
    sources: [
      { path: "src/repository.ts", content: "export function save() {}\n" },
      { path: "src/caller.ts", content: [
        "import * as ns from './repository.js';",
        "export function persist(ns: { save(): void }) { ns.save(); }",
      ].join("\n") },
    ],
  }).artifact.impact!;

  assert.equal(impact.coverage.callFlow, "partial");
  assert.match(impact.coverage.reasons.join(" "), /unresolved call/i);
  assert.equal(impact.relationships.some((relationship) => relationship.kind === "call" && relationship.from.symbol === "persist"), false);
});

test("a local binding shadow prevents resolving through a same-named namespace import", () => {
  const impact = buildProgramFlowSemanticReview({
    workspaceTreeId,
    sanitizedDiff: [
      "diff --git a/src/caller.ts b/src/caller.ts",
      "--- a/src/caller.ts",
      "+++ b/src/caller.ts",
      "@@ -2,0 +3 @@",
      "+  ns.save();",
    ].join("\n"),
    sources: [
      { path: "src/repository.ts", content: "export function save() {}\n" },
      { path: "src/caller.ts", content: [
        "import * as ns from './repository.js';",
        "export function persist(injected: { save(): void }) {",
        "  const ns = injected;",
        "  ns.save();",
        "}",
      ].join("\n") },
    ],
  }).artifact.impact!;

  assert.equal(impact.coverage.callFlow, "partial");
  assert.match(impact.coverage.reasons.join(" "), /unresolved call/i);
  assert.equal(impact.relationships.some((relationship) => relationship.kind === "call" && relationship.from.symbol === "persist"), false);
});
