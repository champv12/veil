import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ContractValidationError, identifyWorkspaceTree } from "../src/index.js";

interface TestFileEntry {
  path: string;
  kind: "file";
  executable: boolean;
  size: number;
  contentSha256: string;
}

interface TestManifest {
  version: 1;
  hashAlgorithm: "sha256";
  entries: TestFileEntry[];
}

async function readOrdinaryFilesFixture(): Promise<TestManifest> {
  return JSON.parse(
    await readFile(
      new URL("./fixtures/workspace-tree/ordinary-files.json", import.meta.url),
      "utf8",
    ),
  );
}

test("ordinary files produce one canonical Workspace Tree identity", async () => {
  const fixture = await readOrdinaryFilesFixture();

  const identified = identifyWorkspaceTree(fixture);

  assert.deepEqual(identified.manifest, {
    entries: [
      {
        contentSha256: "a".repeat(64),
        executable: false,
        kind: "file",
        path: "README.md",
        size: 12,
      },
      {
        contentSha256: "b".repeat(64),
        executable: true,
        kind: "file",
        path: "scripts/build.sh",
        size: 24,
      },
    ],
    hashAlgorithm: "sha256",
    version: 1,
  });
  assert.equal(
    identified.id,
    "sha256:dbbf37342501e90d8c7822a78b04babd445f56ce4b2f7958339d20480af66519",
  );
});

test("Git state cannot enter a Workspace Tree manifest", async () => {
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("./fixtures/workspace-tree/git-state-field.json", import.meta.url),
      "utf8",
    ),
  );

  assert.throws(
    () => identifyWorkspaceTree(fixture),
    (error: unknown) => error instanceof ContractValidationError
      && error.issues.includes("workspace tree manifest contains unknown fields: branch"),
  );
});

test("Workspace Tree paths cannot escape the repository", async () => {
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("./fixtures/workspace-tree/unsafe-path.json", import.meta.url),
      "utf8",
    ),
  );

  assert.throws(
    () => identifyWorkspaceTree(fixture),
    (error: unknown) => error instanceof ContractValidationError
      && error.issues.includes("workspace tree entries[0].path is unsafe"),
  );
});

test("a Workspace Tree cannot contain the same path twice", async () => {
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("./fixtures/workspace-tree/duplicate-path.json", import.meta.url),
      "utf8",
    ),
  );

  assert.throws(
    () => identifyWorkspaceTree(fixture),
    (error: unknown) => error instanceof ContractValidationError
      && error.issues.includes("workspace tree entries contain duplicate path: README.md"),
  );
});

test("malformed Workspace Tree manifests fail closed", async () => {
  const fixtures: Array<{
    name: string;
    expectedIssue: string;
    manifest: unknown;
  }> = JSON.parse(
    await readFile(
      new URL("./fixtures/workspace-tree/invalid-manifests.json", import.meta.url),
      "utf8",
    ),
  );

  for (const fixture of fixtures) {
    assert.throws(
      () => identifyWorkspaceTree(fixture.manifest),
      (error: unknown) => error instanceof ContractValidationError
        && error.issues.includes(fixture.expectedIssue),
      fixture.name,
    );
  }
});

test("entry order does not change Workspace Tree identity", async () => {
  const fixture = await readOrdinaryFilesFixture();
  const reversed = { ...fixture, entries: [...fixture.entries].reverse() };

  assert.equal(identifyWorkspaceTree(fixture).id, identifyWorkspaceTree(reversed).id);
});

test("canonical path order is ordinal rather than locale-dependent", () => {
  const manifest: TestManifest = {
    version: 1,
    hashAlgorithm: "sha256",
    entries: [
      {
        path: "a.txt",
        kind: "file",
        executable: false,
        size: 1,
        contentSha256: "a".repeat(64),
      },
      {
        path: "Z.txt",
        kind: "file",
        executable: false,
        size: 1,
        contentSha256: "b".repeat(64),
      },
    ],
  };

  assert.deepEqual(
    identifyWorkspaceTree(manifest).manifest.entries.map((entry) => entry.path),
    ["Z.txt", "a.txt"],
  );
});

test("source identity changes produce a different Workspace Tree identity", async () => {
  const fixture = await readOrdinaryFilesFixture();
  const originalId = identifyWorkspaceTree(fixture).id;
  const firstEntry = fixture.entries[0];
  assert.ok(firstEntry);

  const variants: TestFileEntry[] = [
    { ...firstEntry, path: "README-renamed.md" },
    { ...firstEntry, executable: !firstEntry.executable },
    { ...firstEntry, size: firstEntry.size + 1 },
    { ...firstEntry, contentSha256: "c".repeat(64) },
  ];

  for (const changedEntry of variants) {
    const changed = {
      ...fixture,
      entries: [changedEntry, ...fixture.entries.slice(1)],
    };
    assert.notEqual(identifyWorkspaceTree(changed).id, originalId);
  }
});
