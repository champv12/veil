import { createHash } from "node:crypto";
import {
  identifySemanticReview,
  type BehavioralSection,
  type DiffHunkEvidence,
  type SemanticReviewIdentity,
  type VerificationEvidence,
} from "@veil/contracts";

export interface StructuralReviewInput {
  workspaceTreeId: `sha256:${string}`;
  sanitizedDiff: string;
  verification?: Array<{
    checkId: string;
    result: VerificationEvidence["result"];
  }>;
}

export function buildStructuralSemanticReview(input: StructuralReviewInput): SemanticReviewIdentity {
  const hunks = parseUnifiedDiff(input.sanitizedDiff);
  const sections: BehavioralSection[] = hunks.map((hunk, index) => {
    const symbol = findChangedSymbol(hunk.lines);
    return {
      id: sectionId(hunk.path, symbol, index),
      kind: hunk.kind ?? classifySection(hunk.path, hunk.lines),
      title: symbol ?? hunk.path,
      summary: symbol ? `Updates ${symbol} in ${hunk.path}.` : `Changes ${hunk.path}.`,
      certainty: "observed",
      evidence: [hunk.evidence],
    };
  });
  for (const verification of input.verification ?? []) {
    sections.push({
      id: sectionId(`check-${verification.checkId}`, undefined, sections.length),
      kind: "test",
      title: verification.checkId,
      summary: `${verification.checkId} ${verification.result}.`,
      certainty: "observed",
      evidence: [{ kind: "verification", ...verification }],
    });
  }
  const paths = new Set(hunks.map((hunk) => hunk.path));
  const diffEvidence = hunks.map((hunk) => hunk.evidence);
  const rawDiffSha256 = createHash("sha256").update(input.sanitizedDiff, "utf8").digest("hex");
  return identifySemanticReview({
    schemaVersion: 1,
    workspaceTreeId: input.workspaceTreeId,
    rawDiff: { mediaType: "text/x-diff", sha256: rawDiffSha256 },
    analysis: { engine: "veil-structural", version: "1.0.0", deterministic: true },
    overview: hunks.length > 0
      ? {
          summary: `Changes ${paths.size} ${paths.size === 1 ? "file" : "files"} across ${hunks.length} review ${hunks.length === 1 ? "section" : "sections"}.`,
          certainty: "observed",
          evidence: diffEvidence,
        }
      : {
          summary: "No supported behavioral analysis is available; inspect the raw diff.",
          certainty: "unsupported",
          evidence: [],
        },
    sections,
  });
}

interface ParsedHunk {
  path: string;
  lines: string[];
  evidence: DiffHunkEvidence;
  kind?: BehavioralSection["kind"];
}

function parseUnifiedDiff(diff: string): ParsedHunk[] {
  const result: ParsedHunk[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let current: ParsedHunk | null = null;
  let fileHasEvidence = false;
  let renameSeen = false;
  const pathForFile = () => newPath ?? oldPath;
  const synthetic = (kind: BehavioralSection["kind"], lines: string[]) => {
    const filePath = pathForFile();
    if (!filePath || fileHasEvidence) return;
    result.push({
      path: filePath,
      lines,
      kind,
      evidence: { kind: "diff-hunk", path: filePath, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 },
    });
    fileHasEvidence = true;
  };
  const finishFile = () => { if (renameSeen) synthetic("other", ["rename"]); };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finishFile();
      oldPath = null;
      newPath = null;
      current = null;
      fileHasEvidence = false;
      renameSeen = false;
      continue;
    }
    const source = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(line);
    if (source) { oldPath = source[1] ?? null; current = null; continue; }
    const target = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(line);
    if (target) { newPath = target[1] ?? null; current = null; continue; }
    if (line.startsWith("rename from ")) { oldPath = line.slice("rename from ".length); renameSeen = true; continue; }
    if (line.startsWith("rename to ")) { newPath = line.slice("rename to ".length); renameSeen = true; continue; }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    const currentPath = pathForFile();
    if (header && currentPath) {
      current = {
        path: currentPath,
        lines: [],
        evidence: {
          kind: "diff-hunk",
          path: currentPath,
          oldStart: Number(header[1]),
          oldLines: Number(header[2] ?? 1),
          newStart: Number(header[3]),
          newLines: Number(header[4] ?? 1),
        },
      };
      result.push(current);
      fileHasEvidence = true;
      continue;
    }
    if (currentPath && (/^Binary files .* differ$/i.test(line) || line === "GIT binary patch")) {
      synthetic("binary", [line]);
      current = null;
      continue;
    }
    if (current && !line.startsWith("diff --git ")) current.lines.push(line);
  }
  finishFile();
  return result;
}

function findChangedSymbol(lines: string[]): string | null {
  for (const line of lines) {
    if (!line.startsWith("+") && !line.startsWith(" ")) continue;
    const source = line.slice(1).trim();
    const match = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/.exec(source)
      ?? /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(source)
      ?? /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[{:]?/.exec(source);
    if (match?.[1] && !["if", "for", "while", "switch", "catch"].includes(match[1])) return match[1];
  }
  return null;
}

function classifySection(path: string, lines: string[]): BehavioralSection["kind"] {
  const lower = path.toLowerCase();
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(lower)) return "test";
  if (/(?:migration|schema)|\.sql$/.test(lower)) return "schema";
  if (/(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.toml|go\.mod)$/.test(lower)) return "dependency";
  if (/(?:^|\/)(?:config|configuration)(?:\/|\.)|\.(?:ya?ml|toml|ini)$/.test(lower)) return "configuration";
  if (lines.some((line) => /binary files .* differ/i.test(line))) return "binary";
  if (lines.length > 0 && lines.every((line) => !line.startsWith("+") || line === "+++ /dev/null")) return "deletion";
  return "behavior";
}

function sectionId(path: string, symbol: string | null | undefined, index: number): string {
  const slug = `${symbol ?? path}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return `${slug || "review"}-${index + 1}`;
}
