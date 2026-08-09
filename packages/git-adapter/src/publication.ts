import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertNoPrivateContent, clearExceptGit, copySanitizedTree, copyTrackedTree } from "./tree.js";
import {
  assertGitObjectId,
  assertSafeGitRef,
  assertSafePublicationBranch,
  cleanEnvironment,
  normalizeGitHubRemote,
  parsePublicGitHubUrl,
  runCommand,
} from "./git.js";
import {
  DurablePublicationCoordinator,
  PublicationObservationIntegrityError,
  type DurablePublicationBasis,
  type DurablePublicationRecord,
  type DurablePublicationStore,
  type GitHubPublicationStateAdapter,
} from "./publication-coordinator.js";

export interface ImportedRepository {
  repositoryUrl: string;
  baseCommit: string;
  defaultBranch: string;
  checkoutPath: string;
}

async function assertSupportedTrackedTree(checkoutPath: string): Promise<void> {
  const entries = await runCommand("git", ["ls-files", "-s"], { cwd: checkoutPath });
  if (entries.stdout.split("\n").some((line) => line.startsWith("120000 "))) {
    throw new Error("V1 does not support repositories containing symbolic links");
  }
  if (entries.stdout.split("\n").some((line) => line.startsWith("160000 "))) {
    throw new Error("V1 does not support Git submodules");
  }
  const reservedVeilPaths = await runCommand("git", ["ls-files", "-z", "--", ".veil"], { cwd: checkoutPath });
  if (reservedVeilPaths.stdout.length > 0) throw new Error("V1 reserves the top-level .veil directory for local Veil context");
}

async function defaultBranch(checkoutPath: string): Promise<string> {
  const remote = await runCommand("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd: checkoutPath, allowFailure: true,
  });
  if (remote.exitCode === 0) return assertSafeGitRef(remote.stdout.trim().replace(/^origin\//, ""), "default branch");
  const local = await runCommand("git", ["symbolic-ref", "--short", "HEAD"], { cwd: checkoutPath, allowFailure: true });
  return local.exitCode === 0 ? assertSafeGitRef(local.stdout.trim(), "default branch") : "main";
}

export async function importPublicRepository(options: {
  repositoryUrl: string;
  ref?: string;
  targetDirectory: string;
}): Promise<ImportedRepository> {
  const repository = parsePublicGitHubUrl(options.repositoryUrl);
  await mkdir(path.dirname(options.targetDirectory), { recursive: true });
  await runCommand("git", ["clone", "--filter=blob:none", "--no-tags", repository.cloneUrl, options.targetDirectory]);
  if (options.ref) {
    assertSafeGitRef(options.ref);
    await runCommand("git", ["checkout", "--detach", options.ref], { cwd: options.targetDirectory });
  }
  const baseCommit = assertGitObjectId((await runCommand("git", ["rev-parse", "HEAD"], { cwd: options.targetDirectory })).stdout.trim());
  await assertSupportedTrackedTree(options.targetDirectory);
  return { repositoryUrl: repository.webUrl, baseCommit, defaultBranch: await defaultBranch(options.targetDirectory), checkoutPath: options.targetDirectory };
}

/**
 * Import an already-authenticated clean local checkout without copying `.git`, ignored files,
 * credentials, hooks, or repository-local configuration into the private work view.
 */
export async function importLocalRepository(options: {
  sourceDirectory: string;
  targetDirectory: string;
  expectedBaseCommit?: string;
  expectedRepositoryUrl?: string;
}): Promise<ImportedRepository> {
  const sourceMetadata = await lstat(options.sourceDirectory);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) throw new Error("Local repository source must be a real directory");
  const sourceDirectory = await realpath(options.sourceDirectory);
  const topLevel = (await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: sourceDirectory })).stdout.trim();
  if (await realpath(topLevel) !== sourceDirectory) throw new Error("Local repository source must be the worktree root");
  const status = await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: sourceDirectory });
  if (status.stdout.length > 0) throw new Error("Local repository must be clean before Veil imports it");
  const baseCommit = assertGitObjectId((await runCommand("git", ["rev-parse", "HEAD"], { cwd: sourceDirectory })).stdout.trim());
  if (options.expectedBaseCommit && baseCommit !== assertGitObjectId(options.expectedBaseCommit, "Expected base commit")) {
    throw new Error("Local repository HEAD no longer matches the approved base commit");
  }
  const origin = (await runCommand("git", ["remote", "get-url", "origin"], { cwd: sourceDirectory })).stdout.trim();
  const repositoryUrl = normalizeGitHubRemote(origin);
  if (options.expectedRepositoryUrl && repositoryUrl !== parsePublicGitHubUrl(options.expectedRepositoryUrl).webUrl) {
    throw new Error("Local repository origin does not match the approved repository");
  }
  await assertSupportedTrackedTree(sourceDirectory);
  await copyTrackedTree(sourceDirectory, options.targetDirectory);
  const finalHead = assertGitObjectId((await runCommand("git", ["rev-parse", "HEAD"], { cwd: sourceDirectory })).stdout.trim());
  const finalStatus = await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: sourceDirectory });
  if (finalHead !== baseCommit || finalStatus.stdout.length > 0) throw new Error("Local repository changed while Veil was importing it");
  return { repositoryUrl, baseCommit, defaultBranch: await defaultBranch(sourceDirectory), checkoutPath: options.targetDirectory };
}

export interface PublicationPreview {
  patch: string;
  patchSha256: string;
  changedFiles: string[];
  insertions: number;
  deletions: number;
  publisherClone: string;
  /** The immutable commit against which `patch` was produced. */
  baseCommit: string;
  /** Credential-free canonical repository identity when this is a publishable remote preview. */
  repositoryUrl?: string;
}

export async function createPatchAgainstDirectory(options: {
  baseDirectory: string;
  candidateDirectory: string;
  workRoot: string;
  forbiddenValues?: string[];
}): Promise<PublicationPreview> {
  const sanitizedCandidate = path.join(options.workRoot, "sanitized-candidate");
  await copySanitizedTree(options.candidateDirectory, sanitizedCandidate);
  await assertNoPrivateContent(sanitizedCandidate, options.forbiddenValues);
  const publisherClone = path.join(options.workRoot, "patch-view");
  await mkdir(publisherClone, { recursive: true });
  await copySanitizedTree(options.baseDirectory, publisherClone);
  await runCommand("git", ["init", "--initial-branch=main"], { cwd: publisherClone });
  await runCommand("git", ["config", "user.name", "Veil Baseline"], { cwd: publisherClone });
  await runCommand("git", ["config", "user.email", "baseline@veil.invalid"], { cwd: publisherClone });
  await runCommand("git", ["add", "-A"], { cwd: publisherClone });
  await runCommand("git", ["commit", "-m", "Veil imported base"], { cwd: publisherClone });
  const baseCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: publisherClone })).stdout.trim();
  await clearExceptGit(publisherClone);
  await copySanitizedTree(sanitizedCandidate, publisherClone);
  await runCommand("git", ["add", "-A"], { cwd: publisherClone });
  const patch = (await runCommand("git", ["diff", "--cached", "--binary", "--no-ext-diff", baseCommit], { cwd: publisherClone })).stdout;
  const changedFiles = (await runCommand("git", ["diff", "--cached", "--name-only", "-z", baseCommit], { cwd: publisherClone })).stdout
    .split("\0").filter(Boolean).sort();
  const numstat = (await runCommand("git", ["diff", "--cached", "--numstat", baseCommit], { cwd: publisherClone })).stdout;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.trim().split("\n").filter(Boolean)) {
    const [added = "0", removed = "0"] = line.split("\t");
    if (added !== "-") insertions += Number(added);
    if (removed !== "-") deletions += Number(removed);
  }
  await runCommand("git", ["reset", "--hard", baseCommit], { cwd: publisherClone });
  await runCommand("git", ["apply", "--check", "-"], { cwd: publisherClone, stdin: patch });
  return {
    patch,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    changedFiles,
    insertions,
    deletions,
    publisherClone,
    baseCommit,
  };
}

export async function preparePublication(options: {
  candidateDirectory: string;
  repositoryUrl: string;
  baseCommit: string;
  forbiddenValues?: string[];
  workRoot?: string;
  /** Authenticated local checkout used only as an object source; never copied into evidence. */
  sourceDirectory?: string;
}): Promise<PublicationPreview> {
  const repository = parsePublicGitHubUrl(options.repositoryUrl);
  const root = options.workRoot ?? (await mkdtemp(path.join(os.tmpdir(), "veil-publish-")));
  const sanitizedCandidate = path.join(root, "sanitized-candidate");
  await copySanitizedTree(options.candidateDirectory, sanitizedCandidate);
  await assertNoPrivateContent(sanitizedCandidate, options.forbiddenValues);
  const publisherClone = path.join(root, "publisher");
  if (options.sourceDirectory) {
    const sourceDirectory = await realpath(options.sourceDirectory);
    // This checkout is an authenticated object carrier only. Direct Git work may
    // legitimately make its index/worktree dirty or advance HEAD after Veil has
    // captured that state; publication still checks out and verifies the exact
    // immutable base object before applying the sealed candidate.
    await runCommand("git", ["cat-file", "-e", `${options.baseCommit}^{commit}`], { cwd: sourceDirectory });
    const sourceOrigin = normalizeGitHubRemote((await runCommand("git", ["remote", "get-url", "origin"], { cwd: sourceDirectory })).stdout.trim());
    if (sourceOrigin !== repository.webUrl) throw new Error("Local publication source origin does not match the reviewed repository");
    await runCommand("git", ["clone", "--no-checkout", "--no-hardlinks", sourceDirectory, publisherClone]);
    await runCommand("git", ["remote", "set-url", "origin", repository.cloneUrl], { cwd: publisherClone });
  } else {
    await runCommand("git", ["clone", "--no-checkout", repository.cloneUrl, publisherClone]);
  }
  await runCommand("git", ["checkout", "--detach", options.baseCommit], { cwd: publisherClone });
  const actualBase = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: publisherClone })).stdout.trim();
  if (actualBase !== options.baseCommit) throw new Error("Publication base commit mismatch");
  await clearExceptGit(publisherClone);
  await copySanitizedTree(sanitizedCandidate, publisherClone);
  await runCommand("git", ["add", "-A"], { cwd: publisherClone });
  const patch = (await runCommand("git", ["diff", "--cached", "--binary", "--no-ext-diff"], { cwd: publisherClone })).stdout;
  const changedFiles = (await runCommand("git", ["diff", "--cached", "--name-only", "-z"], { cwd: publisherClone })).stdout
    .split("\0").filter(Boolean).sort();
  const numstat = (await runCommand("git", ["diff", "--cached", "--numstat"], { cwd: publisherClone })).stdout;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.trim().split("\n").filter(Boolean)) {
    const [added = "0", removed = "0"] = line.split("\t");
    if (added !== "-") insertions += Number(added);
    if (removed !== "-") deletions += Number(removed);
  }
  await runCommand("git", ["reset", "--hard", options.baseCommit], { cwd: publisherClone });
  await runCommand("git", ["apply", "--check", "-"], { cwd: publisherClone, stdin: patch });
  return {
    patch,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    changedFiles,
    insertions,
    deletions,
    publisherClone,
    baseCommit: options.baseCommit,
    repositoryUrl: repository.webUrl,
  };
}

export interface PublicationReceipt {
  branch: string;
  commit: string;
  patchSha256: string;
  pullRequestUrl: string | null;
  publishedAt: string;
}

export interface DurablePublicationOptions {
  id: string;
  changeId: string;
  basis: DurablePublicationBasis;
  store: DurablePublicationStore;
}

/**
 * Publication credentials stay encapsulated behind this boundary. Implementations
 * must not expose tokens through return values, argv, persisted config, receipts,
 * candidate workspaces, or control-plane records.
 */
export interface PublicationAuthorizationAdapter {
  readonly kind: "local-gh" | "github-app-installation";
  assertBranchAvailable(input: { cwd: string; repositoryUrl: string; branch: string }): Promise<void>;
  observeIntegrationHead(input: { cwd: string; repositoryUrl: string; baseBranch: string }): Promise<string | null>;
  observeBranch(input: { cwd: string; repositoryUrl: string; branch: string }): Promise<string | null>;
  findPullRequest(input: { cwd: string; repositoryUrl: string; branch: string; marker: string }): Promise<{ url: string; state: "OPEN" | "CLOSED" | "MERGED"; headCommit: string } | null>;
  push(input: { cwd: string; repositoryUrl: string; branch: string }): Promise<void>;
  createDraftPullRequest(input: {
    cwd: string;
    repositoryUrl: string;
    branch: string;
    baseBranch: string;
    title: string;
    patchSha256: string;
    marker: string;
  }): Promise<string | null>;
}

function githubPublicationEnvironment(): NodeJS.ProcessEnv {
  const environment = cleanEnvironment();
  if (process.env.GH_TOKEN) environment.GH_TOKEN = process.env.GH_TOKEN;
  return environment;
}

export function authenticatedGitHubPushArgs(branch: string): string[] {
  assertSafePublicationBranch(branch);
  return [
    "-c",
    "credential.https://github.com.helper=",
    "-c",
    "credential.https://github.com.helper=!gh auth git-credential",
    "push",
    `--force-with-lease=refs/heads/${branch}:`,
    "--porcelain",
    "origin",
    `HEAD:refs/heads/${branch}`,
  ];
}

export function authenticatedGitHubLsRemoteArgs(branch: string): string[] {
  assertSafePublicationBranch(branch);
  return [
    "-c",
    "credential.https://github.com.helper=",
    "-c",
    "credential.https://github.com.helper=!gh auth git-credential",
    "ls-remote",
    "--heads",
    "origin",
    branch,
  ];
}

/** Existing V1 local GitHub CLI authentication, isolated as its own adapter. */
export const localGhPublicationAuthorization: PublicationAuthorizationAdapter = {
  kind: "local-gh",
  async assertBranchAvailable({ cwd, branch }) {
    const existing = await runCommand("git", authenticatedGitHubLsRemoteArgs(branch), {
      cwd,
      env: githubPublicationEnvironment(),
    });
    if (existing.stdout.trim()) throw new Error("Publication branch already exists");
  },
  async observeBranch({ cwd, branch }) {
    const observed = await runCommand("git", authenticatedGitHubLsRemoteArgs(branch), { cwd, env: githubPublicationEnvironment() });
    const line = observed.stdout.trim();
    if (!line) return null;
    const match = /^([0-9a-f]{40,64})\s+refs\/heads\/.+$/.exec(line);
    if (!match) throw new Error("Remote publication branch response is invalid");
    return assertGitObjectId(match[1]!, "remote publication commit");
  },
  async observeIntegrationHead({ cwd, baseBranch }) {
    const observed = await runCommand("git", authenticatedGitHubLsRemoteArgs(baseBranch), { cwd, env: githubPublicationEnvironment() });
    const line = observed.stdout.trim();
    if (!line) return null;
    const match = /^([0-9a-f]{40,64})\s+refs\/heads\/.+$/.exec(line);
    if (!match) throw new Error("Remote integration response is invalid");
    return assertGitObjectId(match[1]!, "remote integration commit");
  },
  async push({ cwd, branch }) {
    await runCommand("git", authenticatedGitHubPushArgs(branch), {
      cwd,
      env: githubPublicationEnvironment(),
    });
  },
  async findPullRequest({ cwd, repositoryUrl, branch, marker }) {
    const repository = parsePublicGitHubUrl(repositoryUrl);
    const result = await runCommand("gh", [
      "api",
      "--method", "GET",
      `repos/${repository.owner}/${repository.repository}/pulls`,
      "-f", `head=${repository.owner}:${branch}`,
      "-f", "state=all",
      "-f", "per_page=20",
      "--paginate",
      "--slurp",
    ], { cwd, allowFailure: true, env: githubPublicationEnvironment() });
    if (result.exitCode !== 0) throw new Error("Unable to observe the publication pull request through GitHub REST");
    let pages: unknown;
    try { pages = JSON.parse(result.stdout); }
    catch { throw new PublicationObservationIntegrityError(); }
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new PublicationObservationIntegrityError();
    }
    const rows = pages.flat();
    const matches: Array<{ url: string; state: "OPEN" | "CLOSED" | "MERGED"; headCommit: string }> = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new PublicationObservationIntegrityError();
      const item = row as Record<string, unknown>;
      const head = item.head;
      if (
        typeof item.html_url !== "string"
        || (item.state !== "open" && item.state !== "closed")
        || !head || typeof head !== "object" || Array.isArray(head)
        || typeof (head as Record<string, unknown>).sha !== "string"
        || (item.body !== null && typeof item.body !== "string")
        || (item.merged_at !== null && typeof item.merged_at !== "string")
      ) throw new PublicationObservationIntegrityError();
      if (typeof item.body !== "string" || !item.body.includes(marker)) continue;
      let headCommit: string;
      try { headCommit = assertGitObjectId((head as Record<string, unknown>).sha as string, "pull request head commit"); }
      catch { throw new PublicationObservationIntegrityError(); }
      matches.push({
        url: item.html_url,
        state: typeof item.merged_at === "string" ? "MERGED" : item.state === "open" ? "OPEN" : "CLOSED",
        headCommit,
      });
    }
    if (matches.length > 1) throw new PublicationObservationIntegrityError();
    return matches[0] ?? null;
  },
  async createDraftPullRequest({ cwd, repositoryUrl, branch, baseBranch, title, patchSha256, marker }) {
    const repository = parsePublicGitHubUrl(repositoryUrl);
    const result = await runCommand(
      "gh",
      ["pr", "create", "--draft", "--repo", `${repository.owner}/${repository.repository}`, "--head", branch, "--base", baseBranch, "--title", title, "--body", `Published by Veil from patch ${patchSha256}.\n\n<!-- ${marker} -->`],
      { cwd, allowFailure: true, env: githubPublicationEnvironment() },
    );
    return result.exitCode === 0 ? result.stdout.trim() : null;
  },
};

export async function publishPreparedCandidate(options: {
  preview: PublicationPreview;
  branch: string;
  commitMessage: string;
  repositoryUrl: string;
  baseBranch: string;
  confirmation: "publish-selected-candidate";
  createDraftPullRequest?: boolean;
  authorization?: PublicationAuthorizationAdapter;
  durable?: DurablePublicationOptions;
}): Promise<PublicationReceipt> {
  if (options.confirmation !== "publish-selected-candidate") throw new Error("Explicit publication confirmation required");
  assertSafePublicationBranch(options.branch);
  const expectedRepository = parsePublicGitHubUrl(options.repositoryUrl).webUrl;
  if (options.preview.repositoryUrl && options.preview.repositoryUrl !== expectedRepository) throw new Error("Publication repository does not match the prepared result");
  const actualPatchHash = createHash("sha256").update(options.preview.patch).digest("hex");
  if (actualPatchHash !== options.preview.patchSha256) throw new Error("Prepared publication patch failed its integrity check");
  const actualBase = assertGitObjectId((await runCommand("git", ["rev-parse", "HEAD"], { cwd: options.preview.publisherClone })).stdout.trim());
  if (actualBase !== options.preview.baseCommit) throw new Error("Prepared publication base no longer matches the reviewed result");
  const origin = normalizeGitHubRemote((await runCommand("git", ["remote", "get-url", "origin"], { cwd: options.preview.publisherClone })).stdout.trim());
  if (origin !== expectedRepository) throw new Error("Publication remote does not match the reviewed repository");
  const authorization = options.authorization ?? localGhPublicationAuthorization;
  const integrationHead = await authorization.observeIntegrationHead({ cwd: options.preview.publisherClone, repositoryUrl: expectedRepository, baseBranch: options.baseBranch });
  if (integrationHead === null) throw new Error("Publication integration branch is unavailable");
  if (integrationHead !== options.preview.baseCommit) {
    throw new Error(
      `RECONCILE_REQUIRED: repository integration moved from ${options.preview.baseCommit} to ${integrationHead}; `
      + `create a fresh clean checkout at ${integrationHead}, run "veil open .", then produce a new result and renew Semantic Review, checks, and approval`,
    );
  }
  await runCommand("git", ["apply", "--check", "-"], { cwd: options.preview.publisherClone, stdin: options.preview.patch });
  await runCommand("git", ["apply", "-"], { cwd: options.preview.publisherClone, stdin: options.preview.patch });
  await runCommand("git", ["switch", "-c", options.branch], { cwd: options.preview.publisherClone });
  await runCommand("git", ["config", "user.name", "Veil Publisher"], { cwd: options.preview.publisherClone });
  await runCommand("git", ["config", "user.email", "publisher@veil.invalid"], { cwd: options.preview.publisherClone });
  await runCommand("git", ["add", "-A"], { cwd: options.preview.publisherClone });
  const baseTimestamp = (await runCommand("git", ["show", "-s", "--format=%cI", options.preview.baseCommit], { cwd: options.preview.publisherClone })).stdout.trim();
  const deterministicTimestamp = new Date(Date.parse(baseTimestamp) + 1_000).toISOString();
  await runCommand("git", ["commit", "-m", options.commitMessage], { cwd: options.preview.publisherClone, env: { ...cleanEnvironment(), GIT_AUTHOR_DATE: deterministicTimestamp, GIT_COMMITTER_DATE: deterministicTimestamp } });
  const commit = assertGitObjectId((await runCommand("git", ["rev-parse", "HEAD"], { cwd: options.preview.publisherClone })).stdout.trim(), "publication commit");
  const durable = options.durable ?? ephemeralPublication(options.preview.patchSha256, options.branch);
  const coordinator = new DurablePublicationCoordinator({
    store: durable.store,
    remote: publicationRemoteAdapter({
      authorization,
      cwd: options.preview.publisherClone,
      patchSha256: options.preview.patchSha256,
    }),
  });
  await coordinator.prepare({
    id: durable.id,
    changeId: durable.changeId,
    basis: durable.basis,
    repositoryUrl: expectedRepository,
    baseBranch: options.baseBranch,
    branch: options.branch,
    commit,
    title: options.commitMessage,
    createDraftPullRequest: options.createDraftPullRequest === true,
  });
  const publication = await coordinator.advance(durable.id, {
    currentBasisId: durable.basis.id,
    approval: { basisId: durable.basis.id, confirmation: "publish-previewed-basis" },
  });
  if (publication.state !== "published" && publication.state !== "delivered") {
    throw new Error(publication.state === "blocked"
      ? publication.lastError ?? "Publication is blocked by unexpected remote state"
      : `Publication is reconciling after an ambiguous remote outcome${publication.lastError ? `: ${publication.lastError}` : ""}`);
  }
  return {
    branch: options.branch,
    commit,
    patchSha256: options.preview.patchSha256,
    pullRequestUrl: publication.pullRequestUrl ?? null,
    publishedAt: publication.updatedAt,
  };
}

function publicationRemoteAdapter(options: {
  authorization: PublicationAuthorizationAdapter;
  cwd: string;
  patchSha256: string;
}): GitHubPublicationStateAdapter {
  return {
    async observe(input) {
      const [branchCommit, pullRequest] = await Promise.all([
        options.authorization.observeBranch({ cwd: options.cwd, repositoryUrl: input.repositoryUrl, branch: input.branch }),
        options.authorization.findPullRequest({ cwd: options.cwd, repositoryUrl: input.repositoryUrl, branch: input.branch, marker: input.marker }),
      ]);
      return {
        ...(branchCommit === null ? {} : { branchCommit }),
        ...(pullRequest === null ? {} : {
          pullRequest: {
            url: pullRequest.url,
            state: pullRequest.state === "OPEN" ? "open" as const : pullRequest.state === "MERGED" ? "merged" as const : "closed" as const,
            headCommit: pullRequest.headCommit,
            marker: input.marker,
          },
        }),
      };
    },
    async push(input) {
      await options.authorization.push({ cwd: options.cwd, repositoryUrl: input.repositoryUrl, branch: input.branch });
    },
    async createDraftPullRequest(input) {
      const url = await options.authorization.createDraftPullRequest({
        cwd: options.cwd,
        repositoryUrl: input.repositoryUrl,
        branch: input.branch,
        baseBranch: input.baseBranch,
        title: input.title,
        patchSha256: options.patchSha256,
        marker: input.marker,
      });
      if (!url) throw new Error("Pull request creation outcome is ambiguous");
      return url;
    },
  };
}

function ephemeralPublication(patchSha256: string, branch: string): DurablePublicationOptions {
  const digest = createHash("sha256").update(patchSha256).update("\0").update(branch).digest("hex");
  const basisId = `sha256:${digest}` as const;
  return {
    id: `publication_${digest}`,
    changeId: `change_${digest}`,
    basis: {
      id: basisId,
      workspaceTreeId: basisId,
      repositoryAnchorId: basisId,
      reviewId: basisId,
      checkReceiptIds: [],
    },
    store: new MemoryDurablePublicationStore(),
  };
}

class MemoryDurablePublicationStore implements DurablePublicationStore {
  readonly #records = new Map<string, DurablePublicationRecord>();
  async load(id: string): Promise<DurablePublicationRecord | undefined> { const value = this.#records.get(id); return value ? structuredClone(value) : undefined; }
  async save(record: DurablePublicationRecord): Promise<void> { this.#records.set(record.id, structuredClone(record)); }
  async withLock<T>(_id: string, operation: () => Promise<T>): Promise<T> { return operation(); }
}

export async function disposePublicationPreview(preview: PublicationPreview): Promise<void> {
  const parent = path.dirname(preview.publisherClone);
  if (!path.basename(parent).startsWith("veil-publish-")) return;
  await rm(parent, { recursive: true, force: true });
}
