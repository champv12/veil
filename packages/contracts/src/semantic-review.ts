import { createHash } from "node:crypto";
import { ContractValidationError, isRecord } from "./validation.js";

export type ReviewCertainty = "observed" | "inferred" | "unsupported";
export type ReviewSectionKind =
  | "behavior"
  | "api"
  | "schema"
  | "configuration"
  | "dependency"
  | "test"
  | "deletion"
  | "binary"
  | "generated"
  | "other";

export interface DiffHunkEvidence {
  kind: "diff-hunk";
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface SourceRangeEvidence {
  kind: "source-range";
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
}

export interface VerificationEvidence {
  kind: "verification";
  checkId: string;
  result: "passed" | "failed" | "skipped";
}

export type ReviewEvidence = DiffHunkEvidence | SourceRangeEvidence | VerificationEvidence;

export interface ReviewNarrative {
  summary: string;
  certainty: ReviewCertainty;
  evidence: ReviewEvidence[];
}

export interface BehavioralSection extends ReviewNarrative {
  id: string;
  kind: ReviewSectionKind;
  title: string;
}

export type ImpactCoverageLevel = "complete" | "partial" | "unsupported";
export type ImpactRelationshipKind = "import" | "call" | "read" | "write" | "data-flow" | "implementation";

export interface ImpactSymbolReference {
  path: string;
  symbol: string;
  startLine?: number;
  endLine?: number;
}

export interface ImpactRelationship {
  id: string;
  kind: ImpactRelationshipKind;
  from: ImpactSymbolReference;
  to: ImpactSymbolReference;
  certainty: ReviewCertainty;
  evidence: ReviewEvidence[];
}

export interface SemanticImpactAnalysis {
  coverage: {
    callFlow: ImpactCoverageLevel;
    dataFlow: ImpactCoverageLevel;
    reasons: string[];
  };
  relationships: ImpactRelationship[];
  impactedSymbols: ImpactSymbolReference[];
  risk: "low" | "medium" | "high" | "unknown";
}

export interface SemanticReviewArtifact {
  schemaVersion: 1;
  workspaceTreeId: `sha256:${string}`;
  rawDiff: {
    mediaType: "text/x-diff";
    sha256: string;
  };
  analysis: {
    engine: string;
    version: string;
    deterministic: boolean;
  };
  overview: ReviewNarrative;
  sections: BehavioralSection[];
  impact?: SemanticImpactAnalysis;
}

export interface SemanticReviewIdentity {
  id: `sha256:${string}`;
  artifact: SemanticReviewArtifact;
}

export interface SemanticReviewBinding {
  workspaceTreeId: `sha256:${string}`;
  rawDiffSha256: string;
}

export function identifySemanticReview(value: unknown, expected?: SemanticReviewBinding): SemanticReviewIdentity {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.workspaceTreeId !== "string"
    || !isRecord(value.rawDiff)
    || !isRecord(value.analysis)
    || !isRecord(value.overview)
    || !Array.isArray(value.sections)) {
    throw new ContractValidationError(["semantic review artifact is invalid"]);
  }

  const unknownArtifactFields = unknownFields(value, [
    "schemaVersion",
    "workspaceTreeId",
    "rawDiff",
    "analysis",
    "overview",
    "sections",
    "impact",
  ]);
  if (unknownArtifactFields.length > 0) {
    throw new ContractValidationError([
      `semantic review artifact contains unknown fields: ${unknownArtifactFields.join(", ")}`,
    ]);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(value.workspaceTreeId)) {
    throw new ContractValidationError(["semantic review Workspace Tree ID is invalid"]);
  }
  requireOnlyFields(value.rawDiff, ["mediaType", "sha256"], "semantic review raw diff");
  if (value.rawDiff.mediaType !== "text/x-diff") {
    throw new ContractValidationError(["semantic review raw diff media type is unsupported"]);
  }
  if (typeof value.rawDiff.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.rawDiff.sha256)) {
    throw new ContractValidationError(["semantic review raw diff SHA-256 is invalid"]);
  }
  requireOnlyFields(value.analysis, ["engine", "version", "deterministic"], "semantic review analysis");
  if (typeof value.analysis.engine !== "string" || value.analysis.engine.trim().length === 0
    || typeof value.analysis.version !== "string" || value.analysis.version.trim().length === 0
    || typeof value.analysis.deterministic !== "boolean") {
    throw new ContractValidationError(["semantic review analysis declaration is invalid"]);
  }
  requireOnlyFields(value.overview, ["summary", "certainty", "evidence"], "semantic review overview");
  validateNarrative(value.overview, "semantic review overview");
  const sectionIds = new Set<string>();
  value.sections.forEach((section, index) => {
    const label = `semantic review sections[${index}]`;
    if (!isRecord(section)) throw new ContractValidationError([`${label} must be an object`]);
    requireOnlyFields(section, ["id", "kind", "title", "summary", "certainty", "evidence"], label);
    if (typeof section.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(section.id)) {
      throw new ContractValidationError([`${label} id is invalid`]);
    }
    if (sectionIds.has(section.id)) throw new ContractValidationError([`semantic review section id is duplicated: ${section.id}`]);
    sectionIds.add(section.id);
    if (!isReviewSectionKind(section.kind)) throw new ContractValidationError([`${label} kind is unsupported`]);
    if (typeof section.title !== "string" || section.title.trim().length === 0) {
      throw new ContractValidationError([`${label} title must be non-empty`]);
    }
    validateNarrative(section, label);
  });
  if (value.impact !== undefined) validateImpact(value.impact);

  const artifact = value as unknown as SemanticReviewArtifact;
  if (expected && artifact.workspaceTreeId !== expected.workspaceTreeId) {
    throw new ContractValidationError(["semantic review is stale for the requested Workspace Tree ID"]);
  }
  if (expected && artifact.rawDiff.sha256 !== expected.rawDiffSha256) {
    throw new ContractValidationError(["semantic review is stale for the requested raw diff"]);
  }
  const digest = createHash("sha256").update(canonicalJson(artifact), "utf8").digest("hex");
  return { id: `sha256:${digest}`, artifact };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContractValidationError(["semantic review contains a non-finite number"]);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new ContractValidationError(["semantic review contains a non-JSON value"]);
}

function validateNarrative(value: Record<string, unknown>, label: string): void {
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    throw new ContractValidationError([`${label} summary must be non-empty`]);
  }
  if (value.certainty !== "observed" && value.certainty !== "inferred" && value.certainty !== "unsupported") {
    throw new ContractValidationError([`${label} certainty is unsupported`]);
  }
  if (!Array.isArray(value.evidence)) {
    throw new ContractValidationError([`${label} evidence must be an array`]);
  }
  if (value.certainty !== "unsupported" && value.evidence.length === 0) {
    throw new ContractValidationError([`${label} must reference evidence when it is ${value.certainty}`]);
  }
  value.evidence.forEach((evidence, index) => validateEvidence(evidence, `${label} evidence[${index}]`));
}

function unknownFields(value: Record<string, unknown>, allowed: string[]): string[] {
  const allowedFields = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedFields.has(key)).sort();
}

function validateEvidence(value: unknown, label: string): void {
  if (!isRecord(value)) throw new ContractValidationError([`${label} must be an object`]);
  if (value.kind === "verification") {
    requireOnlyFields(value, ["kind", "checkId", "result"], label);
    if (typeof value.checkId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value.checkId)) {
      throw new ContractValidationError([`${label} checkId is invalid`]);
    }
    if (value.result !== "passed" && value.result !== "failed" && value.result !== "skipped") {
      throw new ContractValidationError([`${label} result is unsupported`]);
    }
    return;
  }
  if (value.kind !== "diff-hunk" && value.kind !== "source-range") {
    throw new ContractValidationError([`${label} kind is unsupported`]);
  }
  if (typeof value.path !== "string" || !isSafeSourcePath(value.path)) {
    throw new ContractValidationError([`${label} path is unsafe`]);
  }
  if (value.kind === "diff-hunk") {
    requireOnlyFields(value, ["kind", "path", "oldStart", "oldLines", "newStart", "newLines"], label);
    for (const field of ["oldStart", "oldLines", "newStart", "newLines"] as const) {
      if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
        throw new ContractValidationError([`${label} ${field} must be a non-negative safe integer`]);
      }
    }
    return;
  }
  requireOnlyFields(value, ["kind", "path", "startLine", "endLine", "symbol"], label);
  if (!Number.isSafeInteger(value.startLine) || (value.startLine as number) < 1
    || !Number.isSafeInteger(value.endLine) || (value.endLine as number) < (value.startLine as number)) {
    throw new ContractValidationError([`${label} source range is invalid`]);
  }
  if (value.symbol !== undefined && (typeof value.symbol !== "string" || value.symbol.trim().length === 0)) {
    throw new ContractValidationError([`${label} symbol must be non-empty when present`]);
  }
}

function validateImpact(value: unknown): void {
  if (!isRecord(value)) throw new ContractValidationError(["semantic review impact must be an object"]);
  requireOnlyFields(value, ["coverage", "relationships", "impactedSymbols", "risk"], "semantic review impact");
  if (!isRecord(value.coverage)) throw new ContractValidationError(["semantic review impact coverage must be an object"]);
  requireOnlyFields(value.coverage, ["callFlow", "dataFlow", "reasons"], "semantic review impact coverage");
  for (const field of ["callFlow", "dataFlow"] as const) {
    if (value.coverage[field] !== "complete" && value.coverage[field] !== "partial" && value.coverage[field] !== "unsupported") {
      throw new ContractValidationError([`semantic review impact ${field} coverage is unsupported`]);
    }
  }
  if (!Array.isArray(value.coverage.reasons)
    || value.coverage.reasons.some((reason) => typeof reason !== "string" || reason.trim().length === 0)) {
    throw new ContractValidationError(["semantic review impact coverage reasons are invalid"]);
  }
  if ((value.coverage.callFlow === "unsupported" || value.coverage.dataFlow === "unsupported")
    && value.coverage.reasons.length === 0) {
    throw new ContractValidationError(["unsupported impact coverage requires a reason"]);
  }
  if (!Array.isArray(value.relationships)) throw new ContractValidationError(["semantic review impact relationships must be an array"]);
  const relationshipIds = new Set<string>();
  value.relationships.forEach((relationship, index) => {
    const label = `semantic review impact relationship[${index}]`;
    if (!isRecord(relationship)) throw new ContractValidationError([`${label} must be an object`]);
    requireOnlyFields(relationship, ["id", "kind", "from", "to", "certainty", "evidence"], label);
    if (typeof relationship.id !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(relationship.id)) {
      throw new ContractValidationError([`${label} id is invalid`]);
    }
    if (relationshipIds.has(relationship.id)) throw new ContractValidationError([`${label} id is duplicated`]);
    relationshipIds.add(relationship.id);
    if (!["import", "call", "read", "write", "data-flow", "implementation"].includes(String(relationship.kind))) {
      throw new ContractValidationError([`${label} kind is unsupported`]);
    }
    validateImpactSymbol(relationship.from, `${label} from`);
    validateImpactSymbol(relationship.to, `${label} to`);
    if (relationship.certainty !== "observed" && relationship.certainty !== "inferred" && relationship.certainty !== "unsupported") {
      throw new ContractValidationError([`${label} certainty is unsupported`]);
    }
    if (!Array.isArray(relationship.evidence)) throw new ContractValidationError([`${label} evidence must be an array`]);
    if (relationship.certainty !== "unsupported" && relationship.evidence.length === 0) {
      throw new ContractValidationError([`${label} must reference exact evidence`]);
    }
    relationship.evidence.forEach((evidence, evidenceIndex) => validateEvidence(evidence, `${label} evidence[${evidenceIndex}]`));
  });
  if (!Array.isArray(value.impactedSymbols)) throw new ContractValidationError(["semantic review impacted symbols must be an array"]);
  value.impactedSymbols.forEach((symbol, index) => validateImpactSymbol(symbol, `semantic review impacted symbol[${index}]`));
  if (value.risk !== "low" && value.risk !== "medium" && value.risk !== "high" && value.risk !== "unknown") {
    throw new ContractValidationError(["semantic review impact risk is unsupported"]);
  }
}

function validateImpactSymbol(value: unknown, label: string): void {
  if (!isRecord(value)) throw new ContractValidationError([`${label} must be an object`]);
  requireOnlyFields(value, ["path", "symbol", "startLine", "endLine"], label);
  if (typeof value.path !== "string" || !isSafeSourcePath(value.path)) throw new ContractValidationError([`${label} path is unsafe`]);
  if (typeof value.symbol !== "string" || value.symbol.trim().length === 0) throw new ContractValidationError([`${label} symbol must be non-empty`]);
  if ((value.startLine === undefined) !== (value.endLine === undefined)) {
    throw new ContractValidationError([`${label} source range must include both startLine and endLine`]);
  }
  if (value.startLine !== undefined && (!Number.isSafeInteger(value.startLine) || (value.startLine as number) < 1
    || !Number.isSafeInteger(value.endLine) || (value.endLine as number) < (value.startLine as number))) {
    throw new ContractValidationError([`${label} source range is invalid`]);
  }
}

function requireOnlyFields(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = unknownFields(value, allowed);
  if (unknown.length > 0) {
    throw new ContractValidationError([`${label} contains unknown fields: ${unknown.join(", ")}`]);
  }
}

function isSafeSourcePath(value: string): boolean {
  if (value.length === 0
    || value.includes("\0")
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isReviewSectionKind(value: unknown): value is ReviewSectionKind {
  return [
    "behavior",
    "api",
    "schema",
    "configuration",
    "dependency",
    "test",
    "deletion",
    "binary",
    "generated",
    "other",
  ].includes(String(value));
}
