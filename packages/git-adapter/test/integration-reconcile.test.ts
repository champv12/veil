import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  preparePublication,
  publishPreparedCandidate,
  type PublicationAuthorizationAdapter,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

test("moved integration head fails before remote effects with a deterministic recovery path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-integration-reconcile-"));
  try {
    const source = path.join(root, "source");
    const candidate = path.join(root, "candidate");
    await mkdir(source);
    await mkdir(candidate);
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: source });
    await execFileAsync("git", ["config", "user.name", "Veil Test"], { cwd: source });
    await execFileAsync("git", ["config", "user.email", "test@veil.invalid"], { cwd: source });
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], { cwd: source });
    await writeFile(path.join(source, "app.txt"), "base\n");
    await execFileAsync("git", ["add", "app.txt"], { cwd: source });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: source });
    const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
    await writeFile(path.join(candidate, "app.txt"), "candidate\n");
    const preview = await preparePublication({
      candidateDirectory: candidate,
      repositoryUrl: "https://github.com/acme/app",
      baseCommit,
      sourceDirectory: source,
      workRoot: path.join(root, "publication"),
    });
    const integrationHead = "f".repeat(40);
    let remoteEffects = 0;
    const authorization: PublicationAuthorizationAdapter = {
      kind: "local-gh",
      async observeIntegrationHead() { return integrationHead; },
      async assertBranchAvailable() { remoteEffects += 1; },
      async observeBranch() { remoteEffects += 1; return null; },
      async findPullRequest() { remoteEffects += 1; return null; },
      async push() { remoteEffects += 1; },
      async createDraftPullRequest() { remoteEffects += 1; return null; },
    };

    await assert.rejects(
      publishPreparedCandidate({
        preview,
        branch: "veil/moved-integration",
        commitMessage: "Publish candidate",
        repositoryUrl: "https://github.com/acme/app",
        baseBranch: "main",
        confirmation: "publish-selected-candidate",
        createDraftPullRequest: true,
        authorization,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^RECONCILE_REQUIRED:/);
        assert.match(error.message, new RegExp(integrationHead));
        assert.match(error.message, /fresh clean checkout/i);
        assert.match(error.message, /veil open \./i);
        assert.match(error.message, /new result/i);
        assert.match(error.message, /Semantic Review/i);
        assert.match(error.message, /checks/i);
        assert.match(error.message, /approval/i);
        return true;
      },
    );
    assert.equal(remoteEffects, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
