import { createHash } from "node:crypto";

export interface PatchWorkFragment {
  id: `fragment_${string}`;
  path: string;
  paths: [string];
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  patch: string;
}

/** Convert a Git patch into stable, independently assignable hunk fragments. */
export function workFragmentsFromPatch(patch: string): PatchWorkFragment[] {
  const lines = patch.split(/(?<=\n)/);
  const fragments: PatchWorkFragment[] = [];
  let filePath: string | undefined;
  let fileHeader = "";
  let fileHunkCount = 0;
  let hunk: { header: string; body: string[]; oldStart: number; oldLines: number; newStart: number; newLines: number } | undefined;
  const flushHunk = () => {
    if (!filePath || !hunk) return;
    const content = `${fileHeader}${hunk.header}${hunk.body.join("")}`;
    const digest = createHash("sha256").update(filePath).update("\0").update(content).digest("hex");
    fragments.push({ id: `fragment_${digest}`, path: filePath, paths: [filePath], oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, patch: content });
    fileHunkCount += 1;
    hunk = undefined;
  };
  const flushFile = () => {
    flushHunk();
    if (!filePath || fileHunkCount > 0 || !fileHeader) return;
    const digest = createHash("sha256").update(filePath).update("\0").update(fileHeader).digest("hex");
    fragments.push({ id: `fragment_${digest}`, path: filePath, paths: [filePath], oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, patch: fileHeader });
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      const match = /^diff --git a\/(.+) b\/(.+)\r?\n?$/.exec(line);
      filePath = match?.[2];
      fileHeader = line;
      fileHunkCount = 0;
    } else if (line.startsWith("@@ ")) {
      flushHunk();
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (filePath && match) hunk = { header: line, body: [], oldStart: Number(match[1]), oldLines: match[2] === undefined ? 1 : Number(match[2]), newStart: Number(match[3]), newLines: match[4] === undefined ? 1 : Number(match[4]) };
    } else if (hunk) hunk.body.push(line);
    else if (filePath) fileHeader += line;
  }
  flushFile();
  return fragments;
}
