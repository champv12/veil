import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { observeLocalRepository } from "../src/reconciliation.js";

const exec = promisify(execFile);

test("local Git observation changes its repository anchor for direct edits and commits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-git-observe-"));
  try {
    await git(root, "init", "--quiet");
    await git(root, "config", "user.name", "Veil Test");
    await git(root, "config", "user.email", "veil@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/example/project.git");
    await writeFile(path.join(root, "app.ts"), "export const value = 1;\n");
    await git(root, "add", "app.ts");
    await git(root, "commit", "--quiet", "-m", "base");
    const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const clean = await observeLocalRepository({ cwd: root, expectedRepositoryUrl: "https://github.com/example/project", expectedBaseCommit: baseCommit });
    assert.equal(clean.dirty, false);

    await writeFile(path.join(root, "app.ts"), "export const value = 2;\n");
    const edited = await observeLocalRepository({ cwd: root, expectedRepositoryUrl: "https://github.com/example/project", expectedBaseCommit: baseCommit });
    assert.equal(edited.dirty, true);
    assert.notEqual(edited.repositoryAnchorId, clean.repositoryAnchorId);
    assert.deepEqual(edited.changedPaths, ["app.ts"]);
    assert.deepEqual(edited.sourceState?.entries, [{
      path: "app.ts",
      kind: "file",
      executable: false,
      size: 24,
      contentSha256: createHash("sha256").update("export const value = 2;\n").digest("hex"),
    }]);

    await git(root, "add", "app.ts");
    await git(root, "commit", "--quiet", "-m", "direct edit");
    const committed = await observeLocalRepository({ cwd: root, expectedRepositoryUrl: "https://github.com/example/project", expectedBaseCommit: baseCommit });
    assert.equal(committed.dirty, false);
    assert.notEqual(committed.headCommit, clean.headCommit);
    assert.notEqual(committed.repositoryAnchorId, clean.repositoryAnchorId);
    assert.deepEqual(committed.changedPaths, ["app.ts"]);
    assert.deepEqual(committed.sourceState, edited.sourceState);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local Git observation rejects a changed origin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-git-origin-"));
  try {
    await git(root, "init", "--quiet");
    await git(root, "config", "user.name", "Veil Test");
    await git(root, "config", "user.email", "veil@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/example/other.git");
    await writeFile(path.join(root, "README.md"), "fixture\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "--quiet", "-m", "base");
    await assert.rejects(
      observeLocalRepository({ cwd: root, expectedRepositoryUrl: "https://github.com/example/project" }),
      /origin no longer matches/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}
