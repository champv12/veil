import assert from "node:assert/strict";
import test from "node:test";
import { identifySnapshotWorkspaceTree, type SnapshotManifest } from "../src/index.js";

test("derives Workspace Tree identity from an authenticated snapshot manifest without storage identity", () => {
  const manifest: SnapshotManifest = {
    version: 1,
    files: [
      { path: "src/index.ts", mode: 0o644, size: 12, objectId: "a".repeat(64), sha256: "1".repeat(64) },
      { path: "bin/veil", mode: 0o755, size: 20, objectId: "b".repeat(64), sha256: "2".repeat(64) },
    ],
  };

  const identified = identifySnapshotWorkspaceTree(manifest);
  assert.match(identified.id, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(identified.manifest.entries, [
    { path: "bin/veil", kind: "file", executable: true, size: 20, contentSha256: "2".repeat(64) },
    { path: "src/index.ts", kind: "file", executable: false, size: 12, contentSha256: "1".repeat(64) },
  ]);

  const relocated = structuredClone(manifest);
  relocated.files[0]!.objectId = "c".repeat(64);
  assert.equal(identifySnapshotWorkspaceTree(relocated).id, identified.id);
});
