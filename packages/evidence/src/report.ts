import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChangeState, JsonValue } from "@veil/contracts";
import { redactJson, type RedactionOptions } from "./redact.js";

export type EvidenceGateStatus = "pass" | "fail" | "warning";

export interface EvidenceGate {
  name: string;
  status: EvidenceGateStatus;
  evidence: string;
  evidenceSha256?: string;
}

/** Evidence for the one current private result. `candidateId` is retained on the wire for stored-report compatibility. */
export interface PrivateResultEvidenceSummary {
  candidateId: string;
  snapshotId: string;
  passed: boolean;
  changedFiles: number;
  insertions: number;
  deletions: number;
  patchSha256: string | null;
}

/** @deprecated Use PrivateResultEvidenceSummary. */
export type CandidateEvidenceSummary = PrivateResultEvidenceSummary;

export interface EvidenceReportPayload {
  version: 1;
  reportId: string;
  changeId: string;
  generatedAt: string;
  state: ChangeState;
  baseCommit: string;
  /** Legacy wire name for the current private result ID. */
  selectedCandidateId: string | null;
  /** Legacy wire container. New reports contain at most one current private result. */
  candidates: PrivateResultEvidenceSummary[];
  gates: EvidenceGate[];
  auditHeadHash: string | null;
  publication: {
    mode: "draft_pull_request" | "git_patch";
    branchName: string;
    commitSha: string | null;
    patchSha256: string;
  } | null;
  boundaries: string[];
  metadata: JsonValue;
}

export interface HashBackedEvidenceReport {
  hashAlgorithm: "sha256";
  payloadSha256: string;
  payload: EvidenceReportPayload;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Cannot canonicalize value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}

export function buildEvidenceReport(payload: EvidenceReportPayload, redaction: RedactionOptions = {}): HashBackedEvidenceReport {
  if (payload.candidates.length > 1) throw new Error("Evidence reports support one current private result");
  const redacted = redactJson(payload as unknown as JsonValue, redaction) as unknown as EvidenceReportPayload;
  const payloadSha256 = createHash("sha256").update(canonicalJson(redacted)).digest("hex");
  return { hashAlgorithm: "sha256", payloadSha256, payload: redacted };
}

export function verifyEvidenceReport(report: HashBackedEvidenceReport): boolean {
  if (report.hashAlgorithm !== "sha256") return false;
  const actual = createHash("sha256").update(canonicalJson(report.payload)).digest("hex");
  return actual === report.payloadSha256;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderEvidenceMarkdown(report: HashBackedEvidenceReport): string {
  const { payload } = report;
  const currentResult = payload.candidates.find((result) => result.candidateId === payload.selectedCandidateId)
    ?? payload.candidates[0];
  return [
    `# Veil Evidence Report: ${payload.reportId}`,
    "",
    `**Payload SHA-256:** \`${report.payloadSha256}\``,
    "",
    `Change: \`${payload.changeId}\`  `,
    `State: **${payload.state}**  `,
    `Base commit: \`${payload.baseCommit}\`  `,
    `Current private result: ${currentResult ? `\`${currentResult.candidateId}\`` : "none"}`,
    "",
    "## Gates",
    "",
    "| Gate | Status | Evidence |",
    "|---|---|---|",
    ...payload.gates.map((gate) => `| ${escapeCell(gate.name)} | ${gate.status.toUpperCase()} | ${escapeCell(gate.evidence)} |`),
    "",
    "## Current private result",
    "",
    "| Result | Passed | Files | Diff | Patch SHA-256 |",
    "|---|---|---:|---:|---|",
    ...(currentResult
      ? [`| ${currentResult.candidateId} | ${currentResult.passed ? "yes" : "no"} | ${currentResult.changedFiles} | +${currentResult.insertions}/-${currentResult.deletions} | ${currentResult.patchSha256 ?? "none"} |`]
      : ["No private result has been captured."]),
    "",
    "## Boundaries",
    "",
    ...payload.boundaries.map((boundary) => `- ${boundary}`),
    "",
  ].join("\n");
}

export async function writeEvidenceReport(directory: string, report: HashBackedEvidenceReport): Promise<{ jsonPath: string; markdownPath: string }> {
  if (!verifyEvidenceReport(report)) throw new Error("Refusing to write an invalid evidence report");
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const safeId = report.payload.reportId;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(safeId)) throw new Error("Unsafe report identifier");
  const jsonPath = path.join(root, `${safeId}.json`);
  const markdownPath = path.join(root, `${safeId}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(markdownPath, renderEvidenceMarkdown(report), { flag: "wx", mode: 0o600 });
  return { jsonPath, markdownPath };
}
