import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertNoPrivateContent,
  assertSafeGitRef,
  cleanEnvironment,
  copySanitizedTree,
  createPatchAgainstDirectory,
  importLocalRepository,
  localGhPublicationAuthorization,
  normalizeGitHubRemote,
  parsePublicGitHubUrl,
  publishPreparedCandidate,
  preparePublication,
  DurablePublicationCoordinator,
  PublicationObservationIntegrityError,
  AuthenticatedFileDurablePublicationStore,
  readOnlyGitContext,
  runCommand,
  workFragmentsFromPatch,
} from "../src/index.js";
import type {
  DurablePublicationRecord,
  DurablePublicationStore,
  GitHubPublicationStateAdapter,
  ObservedGitHubPublication,
} from "../src/index.js";
import { authenticatedGitHubLsRemoteArgs, authenticatedGitHubPushArgs } from "../src/publication.js";

const execFileAsync = promisify(execFile);

test("GitHub URL parser accepts canonical public repositories and strips .git", () => {
  assert.deepEqual(parsePublicGitHubUrl("https://github.com/openai/codex.git"), {
    owner: "openai",
    repository: "codex",
    cloneUrl: "https://github.com/openai/codex.git",
    webUrl: "https://github.com/openai/codex",
  });
});

test("command runner enforces output and time bounds", async () => {
  await assert.rejects(runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { maxOutputBytes: 1024 }), /output limit/);
  await assert.rejects(runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 25 }), /timed out/);
});

test("GitHub URL parser rejects credentials, non-GitHub hosts, and nested paths", () => {
  assert.throws(() => parsePublicGitHubUrl("https://token@github.com/openai/codex"));
  assert.throws(() => parsePublicGitHubUrl("https://example.com/openai/codex"));
  assert.throws(() => parsePublicGitHubUrl("https://github.com/openai/codex/issues"));
});

test("publication push uses gh authentication without enabling global Git configuration", () => {
  assert.deepEqual(authenticatedGitHubPushArgs("veil/security-fix"), [
    "-c",
    "credential.https://github.com.helper=",
    "-c",
    "credential.https://github.com.helper=!gh auth git-credential",
    "push",
    "--force-with-lease=refs/heads/veil/security-fix:",
    "--porcelain",
    "origin",
    "HEAD:refs/heads/veil/security-fix",
  ]);
  assert.deepEqual(authenticatedGitHubLsRemoteArgs("veil/security-fix"), [
    "-c",
    "credential.https://github.com.helper=",
    "-c",
    "credential.https://github.com.helper=!gh auth git-credential",
    "ls-remote",
    "--heads",
    "origin",
    "veil/security-fix",
  ]);
});

test("gh-backed publication passes only the explicit GitHub token into clean Git and gh processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-publication-token-"));
  const bin = path.join(root, "bin");
  const fakeGit = path.join(bin, "git");
  const fakeGh = path.join(bin, "gh");
  const previousToken = process.env.GH_TOKEN;
  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousGitPath = process.env.VEIL_GIT_PATH;
  try {
    await mkdir(bin);
    await writeFile(fakeGit, `#!/usr/bin/env node
if (process.env.GH_TOKEN !== "rehearsal-token") {
  process.stderr.write("missing GH_TOKEN\\n");
  process.exit(42);
}
if (process.env.GITHUB_TOKEN || process.env.OPENAI_API_KEY) process.exit(44);
if (!process.argv.includes("credential.https://github.com.helper=!gh auth git-credential")) process.exit(45);
if (!process.argv.includes("push") && !process.argv.includes("ls-remote")) process.exit(43);
`);
    await writeFile(fakeGh, `#!/usr/bin/env node
if (process.env.GH_TOKEN !== "rehearsal-token") process.exit(42);
if (process.env.GITHUB_TOKEN || process.env.OPENAI_API_KEY) process.exit(44);
if (process.argv[2] === "api") {
  if (!process.argv.includes("repos/champv12/veil-rehearsal-fixture/pulls")) process.exit(46);
  for (const value of ["--method", "GET", "--paginate", "--slurp", "head=champv12:veil/rehearsal-token-test", "state=all", "per_page=20"])
    if (!process.argv.includes(value)) process.exit(47);
  const firstPage = Array.from({ length: 20 }, (_, index) => ({
    html_url: "https://github.com/champv12/veil-rehearsal-fixture/pull/" + (index + 10),
    state: "closed", merged_at: null, head: { sha: "${"b".repeat(40)}" }, body: "unrelated",
  }));
  const secondPage = [
    { html_url: "https://github.com/champv12/veil-rehearsal-fixture/pull/1", state: "open", merged_at: null, head: { sha: "${"e".repeat(40)}" }, body: "<!-- veil-publication:test -->" },
    { html_url: "https://github.com/champv12/veil-rehearsal-fixture/pull/2", state: "closed", merged_at: null, head: { sha: "${"f".repeat(40)}" }, body: "<!-- veil-publication:closed -->" },
    { html_url: "https://github.com/champv12/veil-rehearsal-fixture/pull/3", state: "closed", merged_at: "2026-08-09T00:00:00Z", head: { sha: "${"a".repeat(40)}" }, body: "<!-- veil-publication:merged -->" },
  ];
  process.stdout.write(JSON.stringify([firstPage, secondPage]) + "\\n");
  process.exit(0);
}
if (process.argv[2] !== "pr" || process.argv[3] !== "create") process.exit(43);
process.stdout.write("https://github.com/champv12/veil-rehearsal-fixture/pull/1\\n");
`);
    await chmod(fakeGit, 0o755);
    await chmod(fakeGh, 0o755);
    process.env.GH_TOKEN = "rehearsal-token";
    process.env.GITHUB_TOKEN = "must-not-pass";
    process.env.OPENAI_API_KEY = "must-not-pass";
    process.env.VEIL_GIT_PATH = `${bin}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;

    await localGhPublicationAuthorization.assertBranchAvailable({
      cwd: root,
      repositoryUrl: "https://github.com/champv12/veil-rehearsal-fixture",
      branch: "veil/rehearsal-token-test",
    });
    assert.deepEqual(await localGhPublicationAuthorization.findPullRequest({
      cwd: root,
      repositoryUrl: "https://github.com/champv12/veil-rehearsal-fixture",
      branch: "veil/rehearsal-token-test",
      marker: "veil-publication:test",
    }), {
      url: "https://github.com/champv12/veil-rehearsal-fixture/pull/1",
      state: "OPEN",
      headCommit: "e".repeat(40),
    });
    assert.equal((await localGhPublicationAuthorization.findPullRequest({
      cwd: root,
      repositoryUrl: "https://github.com/champv12/veil-rehearsal-fixture",
      branch: "veil/rehearsal-token-test",
      marker: "veil-publication:closed",
    }))?.state, "CLOSED");
    assert.equal((await localGhPublicationAuthorization.findPullRequest({
      cwd: root,
      repositoryUrl: "https://github.com/champv12/veil-rehearsal-fixture",
      branch: "veil/rehearsal-token-test",
      marker: "veil-publication:merged",
    }))?.state, "MERGED");
    await localGhPublicationAuthorization.push({
      cwd: root,
      repositoryUrl: "https://github.com/champv12/veil-rehearsal-fixture",
      branch: "veil/rehearsal-token-test",
    });
    assert.equal(await localGhPublicationAuthorization.createDraftPullRequest({
      cwd: root,
      repositoryUrl: "https://github.com/champv12/veil-rehearsal-fixture",
      branch: "veil/rehearsal-token-test",
      baseBranch: "main",
      title: "Rehearsal token test",
      patchSha256: "a".repeat(64),
      marker: "veil-publication:test",
    }), "https://github.com/champv12/veil-rehearsal-fixture/pull/1");
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousGitPath === undefined) delete process.env.VEIL_GIT_PATH;
    else process.env.VEIL_GIT_PATH = previousGitPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("Git refs and GitHub remotes reject refspecs, traversal, and credentials", () => {
  assert.equal(assertSafeGitRef("refs/heads/main"), "refs/heads/main");
  for (const unsafe of ["--upload-pack=evil", "refs/heads/a..b", "refs/heads/a:b", "refs//heads/main", ".hidden", "@"]) {
    assert.throws(() => assertSafeGitRef(unsafe), /Unsafe/);
  }
  assert.equal(normalizeGitHubRemote("git@github.com:openai/codex.git"), "https://github.com/openai/codex");
  assert.equal(normalizeGitHubRemote("ssh://git@github.com/openai/codex.git"), "https://github.com/openai/codex");
  assert.throws(() => normalizeGitHubRemote("https://token@github.com/openai/codex.git"), /credentials/);
});

test("clean git environment uses platform defaults without inheriting an ambient PATH", () => {
  assert.equal(cleanEnvironment({ HOME: "/safe/home", PATH: "/untrusted/bin" }, "linux").PATH, "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(cleanEnvironment({ HOME: "/safe/home", PATH: "/untrusted/bin" }, "darwin").PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.throws(() => cleanEnvironment({ PATH: "C:\\untrusted" }, "win32"), /required on Windows/);
});

test("clean git environment accepts only an explicit absolute executable path", () => {
  assert.equal(cleanEnvironment({ VEIL_GIT_PATH: "/opt/veil/bin:/usr/bin" }, "linux").PATH, "/opt/veil/bin:/usr/bin");
  assert.throws(() => cleanEnvironment({ VEIL_GIT_PATH: "/usr/bin:relative/bin" }, "linux"), /only absolute directories/);
  assert.throws(() => cleanEnvironment({ VEIL_GIT_PATH: ":/usr/bin" }, "linux"), /only absolute directories/);
});

test("sanitized copy excludes private state and leak scan catches copied sentinels", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-git-test-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await mkdir(path.join(source, ".veil-private"), { recursive: true });
  await mkdir(path.join(source, ".veil"), { recursive: true });
  await writeFile(path.join(source, "index.js"), "export const ok = true;\n");
  await writeFile(path.join(source, ".veil-private", "brief.md"), "SECRET-SENTINEL");
  await writeFile(path.join(source, ".veil", "config.json"), '{"contextId":"local-only"}');
  const copied = await copySanitizedTree(source, target);
  assert.deepEqual(copied, ["index.js"]);
  await assertNoPrivateContent(target, ["SECRET-SENTINEL"]);
  await writeFile(path.join(target, "leak.txt"), "SECRET-SENTINEL");
  await assert.rejects(assertNoPrivateContent(target, ["SECRET-SENTINEL"]));
});

test("local repository import pins HEAD and exports tracked files without Git or ignored secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-local-import-"));
  try {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await mkdir(source);
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: source });
    await execFileAsync("git", ["config", "user.name", "Veil Test"], { cwd: source });
    await execFileAsync("git", ["config", "user.email", "test@veil.invalid"], { cwd: source });
    await execFileAsync("git", ["remote", "add", "origin", "git@github.com:private-owner/private-repo.git"], { cwd: source });
    await writeFile(path.join(source, ".gitignore"), ".env\n");
    await writeFile(path.join(source, "app.ts"), "export const value = 1;\n");
    await writeFile(path.join(source, ".env"), "PRIVATE_TOKEN=must-not-copy\n");
    await execFileAsync("git", ["add", ".gitignore", "app.ts"], { cwd: source });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: source });
    const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
    const imported = await importLocalRepository({ sourceDirectory: source, targetDirectory: target, expectedBaseCommit: baseCommit });
    assert.equal(imported.baseCommit, baseCommit);
    assert.equal(imported.repositoryUrl, "https://github.com/private-owner/private-repo");
    assert.equal(await readFile(path.join(target, "app.ts"), "utf8"), "export const value = 1;\n");
    await assert.rejects(stat(path.join(target, ".git")), /ENOENT/);
    await assert.rejects(stat(path.join(target, ".env")), /ENOENT/);
    await assert.rejects(importLocalRepository({ sourceDirectory: source, targetDirectory: path.join(root, "other"), expectedBaseCommit: "a".repeat(40) }), /approved base commit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-only Git context binds the base and bounds paths and line ranges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-git-context-test-"));
  try {
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Veil Test"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@veil.invalid"], { cwd: root });
    await writeFile(path.join(root, "file.txt"), "one\ntwo\nthree\n");
    await execFileAsync("git", ["add", "file.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });
    const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    assert.equal((await readOnlyGitContext({ repositoryDirectory: root, expectedBaseCommit: baseCommit, request: { operation: "base" } })).output, baseCommit);
    assert.match((await readOnlyGitContext({ repositoryDirectory: root, expectedBaseCommit: baseCommit, request: { operation: "file-history", path: "file.txt", limit: 1 } })).output, /base/);
    assert.match((await readOnlyGitContext({ repositoryDirectory: root, expectedBaseCommit: baseCommit, request: { operation: "blame", path: "file.txt", startLine: 1, endLine: 2 } })).output, /filename file\.txt/);
    await assert.rejects(readOnlyGitContext({ repositoryDirectory: root, expectedBaseCommit: baseCommit, request: { operation: "file-history", path: "../secret" } }), /Unsafe repository path/);
    await assert.rejects(readOnlyGitContext({ repositoryDirectory: root, expectedBaseCommit: baseCommit, request: { operation: "blame", path: "file.txt", startLine: 1, endLine: 501 } }), /between/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publication rechecks the sealed patch before any remote operation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-publish-integrity-"));
  try {
    const base = path.join(root, "base");
    const candidate = path.join(root, "candidate");
    await mkdir(base); await mkdir(candidate);
    await writeFile(path.join(base, "file.txt"), "base\n");
    await writeFile(path.join(candidate, "file.txt"), "changed\n");
    const preview = await createPatchAgainstDirectory({ baseDirectory: base, candidateDirectory: candidate, workRoot: path.join(root, "work") });
    preview.patch += "tampered";
    await assert.rejects(publishPreparedCandidate({
      preview, branch: "veil/integrity", commitMessage: "test", repositoryUrl: "https://github.com/openai/codex",
      baseBranch: "main", confirmation: "publish-selected-candidate",
    }), /integrity check/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("durable publication resumes ambiguous push and PR creation without duplicates", async () => {
  const records = new Map<string, DurablePublicationRecord>();
  const store: DurablePublicationStore = {
    async load(id) { return structuredClone(records.get(id)); },
    async save(record) { records.set(record.id, structuredClone(record)); },
    async withLock(_id, operation) { return operation(); },
  };
  let branchCommit: string | undefined;
  let pullRequest: ObservedGitHubPublication["pullRequest"];
  let pushes = 0;
  let pullRequests = 0;
  let failInitialObservation = true;
  let failPushAfterEffect = true;
  let failPullRequestAfterEffect = true;
  const remote: GitHubPublicationStateAdapter = {
    async observe() {
      if (failInitialObservation) { failInitialObservation = false; throw new Error("fixture observation unavailable"); }
      return {
        ...(branchCommit === undefined ? {} : { branchCommit }),
        ...(pullRequest === undefined ? {} : { pullRequest: structuredClone(pullRequest) }),
      };
    },
    async push(input) {
      const durable = records.get("publication_1");
      assert.equal(durable?.state, "reconciling");
      assert.equal(durable?.stepJournal.at(-1)?.step, "push");
      assert.equal(durable?.stepJournal.at(-1)?.status, "started");
      pushes += 1;
      branchCommit = input.commit;
      if (failPushAfterEffect) { failPushAfterEffect = false; throw new Error("timeout after push"); }
    },
    async createDraftPullRequest(input) {
      const durable = records.get("publication_1");
      assert.equal(durable?.state, "reconciling");
      assert.equal(durable?.stepJournal.at(-1)?.step, "pull-request");
      assert.equal(durable?.stepJournal.at(-1)?.status, "started");
      pullRequests += 1;
      pullRequest = { url: "https://github.com/acme/app/pull/7", state: "open", headCommit: input.commit, marker: input.marker };
      if (failPullRequestAfterEffect) { failPullRequestAfterEffect = false; throw new Error("timeout after pull request"); }
      return pullRequest.url;
    },
  };
  const input = {
    id: "publication_1",
    changeId: "change_1",
    basis: {
      id: `sha256:${"a".repeat(64)}`,
      workspaceTreeId: `sha256:${"b".repeat(64)}`,
      repositoryAnchorId: `sha256:${"c".repeat(64)}`,
      reviewId: `sha256:${"d".repeat(64)}`,
      checkReceiptIds: ["check_1"],
    },
    repositoryUrl: "https://github.com/acme/app",
    baseBranch: "main",
    branch: "veil/profile-validation",
    commit: "e".repeat(40),
    title: "Validate profiles",
  } as const;
  const first = new DurablePublicationCoordinator({ store, remote, now: () => "2026-08-09T12:00:00.000Z" });
  await first.prepare(input);
  const afterInitialObservationFailure = await first.advance("publication_1", {
    currentBasisId: input.basis.id,
    approval: { basisId: input.basis.id, confirmation: "publish-previewed-basis" },
  });
  assert.equal(afterInitialObservationFailure.state, "reconciling");
  assert.equal(afterInitialObservationFailure.lastError, "Initial GitHub publication observation failed");
  assert.equal(pushes, 0);
  const afterPushTimeout = await first.advance("publication_1", {
    currentBasisId: input.basis.id,
  });
  assert.equal(afterPushTimeout.state, "reconciling");
  assert.equal(pushes, 1);

  const restarted = new DurablePublicationCoordinator({ store, remote, now: () => "2026-08-09T12:01:00.000Z" });
  const afterPrTimeout = await restarted.advance("publication_1", { currentBasisId: input.basis.id });
  assert.equal(afterPrTimeout.state, "reconciling");
  assert.equal(pushes, 1);
  assert.equal(pullRequests, 1);

  const completed = await restarted.advance("publication_1", { currentBasisId: input.basis.id });
  assert.equal(completed.state, "published");
  assert.equal(completed.pullRequestUrl, "https://github.com/acme/app/pull/7");
  assert.equal(pushes, 1);
  assert.equal(pullRequests, 1);
});

test("publication renewal fails closed on a changed basis and GitHub-only merge delivers", async () => {
  let record: DurablePublicationRecord | undefined;
  let observed: ObservedGitHubPublication = {};
  const store: DurablePublicationStore = {
    async load() { return record ? structuredClone(record) : undefined; },
    async save(value) { record = structuredClone(value); },
    async withLock(_id, operation) { return operation(); },
  };
  const remote: GitHubPublicationStateAdapter = {
    async observe() { return structuredClone(observed); },
    async push(input) { observed.branchCommit = input.commit; },
    async createDraftPullRequest(input) {
      observed.pullRequest = { url: "https://github.com/acme/app/pull/8", state: "open", headCommit: input.commit, marker: input.marker };
      return observed.pullRequest.url;
    },
  };
  const coordinator = new DurablePublicationCoordinator({ store, remote, now: () => "2026-08-09T12:00:00.000Z" });
  const basisId = `sha256:${"a".repeat(64)}` as const;
  await coordinator.prepare({
    id: "publication_2", changeId: "change_2",
    basis: { id: basisId, workspaceTreeId: `sha256:${"b".repeat(64)}`, repositoryAnchorId: `sha256:${"c".repeat(64)}`, reviewId: `sha256:${"d".repeat(64)}`, checkReceiptIds: [] },
    repositoryUrl: "https://github.com/acme/app", baseBranch: "main", branch: "veil/cache", commit: "e".repeat(40), title: "Cache profiles",
  });
  const stale = await coordinator.advance("publication_2", { currentBasisId: `sha256:${"f".repeat(64)}` });
  assert.equal(stale.state, "needs-renewed-review");
  const withoutRenewal = await coordinator.advance("publication_2", { currentBasisId: basisId });
  assert.equal(withoutRenewal.state, "needs-renewed-review");
  await coordinator.advance("publication_2", { currentBasisId: basisId, approval: { basisId, confirmation: "publish-previewed-basis" } });
  observed.pullRequest = { ...observed.pullRequest!, state: "merged" };
  const delivered = await coordinator.reconcile("publication_2", basisId);
  assert.equal(delivered.state, "delivered");
});

test("deterministic publication observation corruption blocks before remote effects", async () => {
  let record: DurablePublicationRecord | undefined;
  let remoteEffects = 0;
  const store: DurablePublicationStore = {
    async load() { return record ? structuredClone(record) : undefined; },
    async save(value) { record = structuredClone(value); },
    async withLock(_id, operation) { return operation(); },
  };
  const remote: GitHubPublicationStateAdapter = {
    async observe() { throw new PublicationObservationIntegrityError(); },
    async push() { remoteEffects += 1; },
    async createDraftPullRequest() { remoteEffects += 1; return "https://github.com/acme/app/pull/9"; },
  };
  const coordinator = new DurablePublicationCoordinator({ store, remote });
  const basisId = `sha256:${"a".repeat(64)}` as const;
  await coordinator.prepare({
    id: "publication_corrupt_observation",
    changeId: "change_corrupt_observation",
    basis: { id: basisId, workspaceTreeId: `sha256:${"b".repeat(64)}`, repositoryAnchorId: `sha256:${"c".repeat(64)}`, reviewId: `sha256:${"d".repeat(64)}`, checkReceiptIds: [] },
    repositoryUrl: "https://github.com/acme/app",
    baseBranch: "main",
    branch: "veil/corrupt-observation",
    commit: "e".repeat(40),
    title: "Reject corrupt observation",
  });

  const blocked = await coordinator.advance("publication_corrupt_observation", {
    currentBasisId: basisId,
    approval: { basisId, confirmation: "publish-previewed-basis" },
  });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.lastError, "GitHub publication observation failed integrity validation");
  assert.equal(remoteEffects, 0);
});

test("post-push observation corruption blocks while preserving the remote-effect boundary", async () => {
  let record: DurablePublicationRecord | undefined;
  let observations = 0;
  let pushes = 0;
  const store: DurablePublicationStore = {
    async load() { return record ? structuredClone(record) : undefined; },
    async save(value) { record = structuredClone(value); },
    async withLock(_id, operation) { return operation(); },
  };
  const remote: GitHubPublicationStateAdapter = {
    async observe() {
      observations += 1;
      if (observations === 2) throw new PublicationObservationIntegrityError();
      return {};
    },
    async push() { pushes += 1; },
    async createDraftPullRequest() { return "https://github.com/acme/app/pull/10"; },
  };
  const coordinator = new DurablePublicationCoordinator({ store, remote });
  const basisId = `sha256:${"a".repeat(64)}` as const;
  await coordinator.prepare({
    id: "publication_post_push_corruption",
    changeId: "change_post_push_corruption",
    basis: { id: basisId, workspaceTreeId: `sha256:${"b".repeat(64)}`, repositoryAnchorId: `sha256:${"c".repeat(64)}`, reviewId: `sha256:${"d".repeat(64)}`, checkReceiptIds: [] },
    repositoryUrl: "https://github.com/acme/app",
    baseBranch: "main",
    branch: "veil/post-push-corruption",
    commit: "e".repeat(40),
    title: "Block corrupt post-push observation",
  });

  const blocked = await coordinator.advance("publication_post_push_corruption", {
    currentBasisId: basisId,
    approval: { basisId, confirmation: "publish-previewed-basis" },
  });
  assert.equal(pushes, 1);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.lastError, "Post-effect GitHub publication observation failed integrity validation");
});

test("Git patch hunks become stable, independently assignable Work Fragments", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts\n", "index 1111111..2222222 100644\n", "--- a/src/a.ts\n", "+++ b/src/a.ts\n",
    "@@ -1,2 +1,2 @@\n", "-old\n", "+new\n", " keep\n",
    "@@ -10 +10,2 @@\n", " value\n", "+extra\n",
  ].join("");
  const first = workFragmentsFromPatch(patch);
  assert.deepEqual(first, workFragmentsFromPatch(patch));
  assert.deepEqual(first.map((item) => ({ path: item.path, oldStart: item.oldStart, newStart: item.newStart })), [
    { path: "src/a.ts", oldStart: 1, newStart: 1 },
    { path: "src/a.ts", oldStart: 10, newStart: 10 },
  ]);
  assert.notEqual(first[0]!.id, first[1]!.id);
});

test("file-backed production publication serializes concurrent callers and survives restart without duplicate effects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-idempotent-publication-"));
  try {
    const source = path.join(root, "source");
    const candidate = path.join(root, "candidate");
    await mkdir(source); await mkdir(candidate);
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: source });
    await execFileAsync("git", ["config", "user.name", "Veil Test"], { cwd: source });
    await execFileAsync("git", ["config", "user.email", "test@veil.invalid"], { cwd: source });
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], { cwd: source });
    await writeFile(path.join(source, "app.txt"), "base\n");
    await execFileAsync("git", ["add", "app.txt"], { cwd: source });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: source, env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-09T00:00:00Z", GIT_COMMITTER_DATE: "2026-08-09T00:00:00Z" } });
    const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
    await writeFile(path.join(candidate, "app.txt"), "changed\n");
    let branchCommit: string | null = null;
    let pullRequest: { url: string; state: "OPEN"; headCommit: string; marker: string } | null = null;
    let pushes = 0;
    let creates = 0;
    const authenticationKey = randomBytes(32);
    const authorization = {
      kind: "local-gh" as const,
      async assertBranchAvailable() {},
      async observeIntegrationHead() { return baseCommit; },
      async observeBranch() { return branchCommit; },
      async findPullRequest(input: { marker: string }) { return pullRequest?.marker === input.marker ? { url: pullRequest.url, state: pullRequest.state, headCommit: pullRequest.headCommit } : null; },
      async push(input: { cwd: string }) { pushes += 1; branchCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.cwd })).stdout.trim(); },
      async createDraftPullRequest(input: { cwd: string; marker: string }) { creates += 1; const headCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.cwd })).stdout.trim(); pullRequest = { url: "https://github.com/acme/app/pull/1", state: "OPEN", headCommit, marker: input.marker }; return null; },
    };
    const basis = {
      id: `sha256:${"1".repeat(64)}` as const,
      workspaceTreeId: `sha256:${"2".repeat(64)}` as const,
      repositoryAnchorId: `sha256:${"3".repeat(64)}` as const,
      reviewId: `sha256:${"4".repeat(64)}` as const,
      checkReceiptIds: ["check_production_restart"],
    };
    const publish = async (attempt: number) => {
      const preview = await preparePublication({ candidateDirectory: candidate, repositoryUrl: "https://github.com/acme/app", baseCommit, sourceDirectory: source, workRoot: path.join(root, `attempt-${attempt}`) });
      return publishPreparedCandidate({
        preview, branch: "veil/idempotent", commitMessage: "Publish exact result",
        repositoryUrl: "https://github.com/acme/app", baseBranch: "main",
        confirmation: "publish-selected-candidate", createDraftPullRequest: true, authorization,
        durable: {
          id: "publication_production_restart",
          changeId: "change_production_restart",
          basis,
          store: new AuthenticatedFileDurablePublicationStore(path.join(root, "durable"), authenticationKey),
        },
      });
    };
    const concurrent = await Promise.allSettled([publish(1), publish(2)]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
    const completed = await publish(3);
    assert.equal(completed.pullRequestUrl, "https://github.com/acme/app/pull/1");
    assert.equal(pushes, 1);
    assert.equal(creates, 1);
    authenticationKey.fill(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
