import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface LeakNeedle {
  label: string;
  value: string | Buffer;
}

export interface LeakFinding {
  label: string;
  relativePath: string;
  kind: "content" | "unsafe_entry";
  fileSha256: string | null;
}

export interface LeakScanResult {
  passed: boolean;
  scannedFiles: number;
  scannedBytes: number;
  findings: LeakFinding[];
}

export async function scanTreeForLeaks(options: {
  root: string;
  needles: LeakNeedle[];
  excludeTopLevel?: string[];
}): Promise<LeakScanResult> {
  const root = path.resolve(options.root);
  const excluded = new Set(options.excludeTopLevel ?? [".git", ".veil", ".veil-private", ".veil-state", ".veil-runs"]);
  const findings: LeakFinding[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;

  const visit = async (relativeDirectory: string): Promise<void> => {
    const directory = relativeDirectory ? path.join(root, relativeDirectory) : root;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!relativeDirectory && excluded.has(entry.name)) continue;
      const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      const absolutePath = path.join(root, relativePath);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
        findings.push({ label: "unsupported filesystem entry", relativePath, kind: "unsafe_entry", fileSha256: null });
        continue;
      }
      if (metadata.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      const contents = await readFile(absolutePath);
      scannedFiles += 1;
      scannedBytes += contents.length;
      let digest: string | null = null;
      for (const needle of options.needles) {
        const bytes = typeof needle.value === "string" ? Buffer.from(needle.value, "utf8") : needle.value;
        if (bytes.length === 0) throw new Error(`Leak needle cannot be empty: ${needle.label}`);
        if (contents.includes(bytes)) {
          digest ??= createHash("sha256").update(contents).digest("hex");
          findings.push({ label: needle.label, relativePath, kind: "content", fileSha256: digest });
        }
      }
    }
  };

  await visit("");
  return { passed: findings.length === 0, scannedFiles, scannedBytes, findings };
}

export function assertNoLeaks(result: LeakScanResult): void {
  if (!result.passed) {
    const summary = result.findings.map((finding) => `${finding.label} in ${finding.relativePath}`).join(", ");
    throw new Error(`Leak scan failed: ${summary}`);
  }
}
