import { assertGitObjectId, assertSafeGitRef, assertSafePublicationBranch, parsePublicGitHubUrl } from "./git.js";

export type DurablePublicationState =
  | "preview"
  | "approved"
  | "reconciling"
  | "needs-renewed-review"
  | "published"
  | "delivered"
  | "blocked";

export interface DurablePublicationBasis {
  id: `sha256:${string}`;
  workspaceTreeId: `sha256:${string}`;
  repositoryAnchorId: `sha256:${string}`;
  reviewId: `sha256:${string}`;
  checkReceiptIds: readonly string[];
}

export interface DurablePublicationRecord {
  id: string;
  changeId: string;
  basis: DurablePublicationBasis;
  repositoryUrl: string;
  baseBranch: string;
  branch: string;
  commit: string;
  title: string;
  marker: string;
  createDraftPullRequest: boolean;
  state: DurablePublicationState;
  completedSteps: Array<{ step: "push" | "pull-request" | "verify"; completedAt: string }>;
  stepJournal: Array<{
    step: "push" | "pull-request" | "verify";
    status: "started" | "completed";
    at: string;
  }>;
  pullRequestUrl?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DurablePublicationStore {
  load(id: string): Promise<DurablePublicationRecord | undefined>;
  save(record: DurablePublicationRecord): Promise<void>;
  /** Serialize publication decisions across processes/instances for this ID. */
  withLock<T>(id: string, operation: () => Promise<T>): Promise<T>;
}

export interface ObservedGitHubPublication {
  branchCommit?: string;
  pullRequest?: {
    url: string;
    state: "open" | "closed" | "merged";
    headCommit: string;
    marker: string;
  };
}

export interface GitHubPublicationStateAdapter {
  observe(input: {
    repositoryUrl: string;
    branch: string;
    marker: string;
  }): Promise<ObservedGitHubPublication>;
  push(input: {
    repositoryUrl: string;
    branch: string;
    commit: string;
    marker: string;
  }): Promise<void>;
  createDraftPullRequest(input: {
    repositoryUrl: string;
    baseBranch: string;
    branch: string;
    commit: string;
    title: string;
    marker: string;
  }): Promise<string>;
}

export interface PrepareDurablePublicationInput {
  id: string;
  changeId: string;
  basis: DurablePublicationBasis;
  repositoryUrl: string;
  baseBranch: string;
  branch: string;
  commit: string;
  title: string;
  createDraftPullRequest?: boolean;
}

export class DurablePublicationCoordinator {
  readonly #store: DurablePublicationStore;
  readonly #remote: GitHubPublicationStateAdapter;
  readonly #now: () => string;

  constructor(options: {
    store: DurablePublicationStore;
    remote: GitHubPublicationStateAdapter;
    now?: () => string;
  }) {
    this.#store = options.store;
    this.#remote = options.remote;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async prepare(input: PrepareDurablePublicationInput): Promise<DurablePublicationRecord> {
    return this.#store.withLock(input.id, async () => this.#prepareLocked(input));
  }

  async #prepareLocked(input: PrepareDurablePublicationInput): Promise<DurablePublicationRecord> {
    validateIdentifier(input.id, "publication ID");
    validateIdentifier(input.changeId, "change ID");
    validateBasis(input.basis);
    const repositoryUrl = parsePublicGitHubUrl(input.repositoryUrl).webUrl;
    const branch = assertSafePublicationBranch(input.branch);
    const baseBranch = assertSafeGitRef(input.baseBranch, "publication base branch");
    const commit = assertGitObjectId(input.commit, "publication commit");
    const title = input.title.trim();
    if (title.length < 3 || title.length > 200) throw new Error("publication title must be between 3 and 200 characters");
    const existing = await this.#store.load(input.id);
    if (existing) {
      const same = existing.changeId === input.changeId
        && existing.basis.id === input.basis.id
        && existing.repositoryUrl === repositoryUrl
        && existing.baseBranch === baseBranch
        && existing.branch === branch
        && existing.commit === commit
        && existing.title === title
        && existing.createDraftPullRequest === (input.createDraftPullRequest ?? true);
      if (!same) throw new Error("publication ID was already prepared with different input");
      return existing;
    }
    const now = this.#now();
    const record: DurablePublicationRecord = {
      id: input.id,
      changeId: input.changeId,
      basis: structuredClone(input.basis),
      repositoryUrl,
      baseBranch,
      branch,
      commit,
      title,
      marker: `veil-publication:${input.id}:${input.basis.id}`,
      createDraftPullRequest: input.createDraftPullRequest ?? true,
      state: "preview",
      completedSteps: [],
      stepJournal: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.save(record);
    return structuredClone(record);
  }

  async advance(
    publicationId: string,
    input: {
      currentBasisId: `sha256:${string}`;
      approval?: { basisId: `sha256:${string}`; confirmation: "publish-previewed-basis" };
    },
  ): Promise<DurablePublicationRecord> {
    return this.#store.withLock(publicationId, async () => this.#advanceLocked(publicationId, input));
  }

  async #advanceLocked(
    publicationId: string,
    input: {
      currentBasisId: `sha256:${string}`;
      approval?: { basisId: `sha256:${string}`; confirmation: "publish-previewed-basis" };
    },
  ): Promise<DurablePublicationRecord> {
    const record = await this.#required(publicationId);
    if (input.currentBasisId !== record.basis.id) {
      record.state = "needs-renewed-review";
      record.updatedAt = this.#now();
      record.lastError = "The current publication basis differs from the previewed basis";
      await this.#store.save(record);
      return structuredClone(record);
    }
    if (record.state === "preview" || record.state === "needs-renewed-review") {
      if (!input.approval) return structuredClone(record);
      if (input.approval.confirmation !== "publish-previewed-basis" || input.approval.basisId !== record.basis.id) {
        throw new Error("publication approval does not match the previewed basis");
      }
      record.state = "approved";
      record.updatedAt = this.#now();
      delete record.lastError;
      await this.#store.save(record);
    }
    if (record.state === "delivered" || record.state === "published" || record.state === "blocked") {
      return this.#reconcileLocked(publicationId, input.currentBasisId);
    }

    let observed = await this.#remote.observe(remoteInput(record));
    const reconciled = this.#applyObservation(record, observed);
    if (reconciled.state === "blocked" || reconciled.state === "delivered" || reconciled.state === "published") {
      await this.#store.save(reconciled);
      return structuredClone(reconciled);
    }

    if (!hasStep(record, "push")) {
      await this.#startStep(record, "push");
      try {
        await this.#remote.push({
          repositoryUrl: record.repositoryUrl,
          branch: record.branch,
          commit: record.commit,
          marker: record.marker,
        });
        await this.#completeStep(record, "push");
      } catch (error) {
        return this.#reconciling(record, error);
      }
    }

    observed = await this.#remote.observe(remoteInput(record));
    this.#applyObservation(record, observed);
    if ((record as DurablePublicationRecord).state === "blocked") {
      await this.#store.save(record);
      return structuredClone(record);
    }
    if (!record.createDraftPullRequest && hasStep(record, "push")) {
      record.state = "published";
      record.updatedAt = this.#now();
      delete record.lastError;
      await this.#store.save(record);
      return structuredClone(record);
    }
    if (!hasStep(record, "pull-request")) {
      await this.#startStep(record, "pull-request");
      try {
        record.pullRequestUrl = await this.#remote.createDraftPullRequest({
          repositoryUrl: record.repositoryUrl,
          baseBranch: record.baseBranch,
          branch: record.branch,
          commit: record.commit,
          title: record.title,
          marker: record.marker,
        });
        await this.#completeStep(record, "pull-request");
      } catch (error) {
        return this.#reconciling(record, error);
      }
    }
    record.state = "published";
    record.updatedAt = this.#now();
    delete record.lastError;
    await this.#store.save(record);
    return structuredClone(record);
  }

  async reconcile(publicationId: string, currentBasisId: `sha256:${string}`): Promise<DurablePublicationRecord> {
    return this.#store.withLock(publicationId, async () => this.#reconcileLocked(publicationId, currentBasisId));
  }

  async #reconcileLocked(publicationId: string, currentBasisId: `sha256:${string}`): Promise<DurablePublicationRecord> {
    const record = await this.#required(publicationId);
    if (currentBasisId !== record.basis.id) {
      record.state = "needs-renewed-review";
      record.updatedAt = this.#now();
      record.lastError = "The current publication basis differs from the previewed basis";
      await this.#store.save(record);
      return structuredClone(record);
    }
    const observed = await this.#remote.observe(remoteInput(record));
    this.#applyObservation(record, observed);
    record.updatedAt = this.#now();
    await this.#store.save(record);
    return structuredClone(record);
  }

  #applyObservation(record: DurablePublicationRecord, observed: ObservedGitHubPublication): DurablePublicationRecord {
    if (observed.branchCommit) {
      if (observed.branchCommit !== record.commit) {
        record.state = "blocked";
        record.lastError = "The publication branch points to an unexpected commit";
        return record;
      }
      completeObservedStep(record, "push", this.#now());
    }
    if (observed.pullRequest) {
      const pullRequest = observed.pullRequest;
      if (pullRequest.marker !== record.marker || pullRequest.headCommit !== record.commit) {
        record.state = "blocked";
        record.lastError = "The observed pull request does not match the publication marker and commit";
        return record;
      }
      record.pullRequestUrl = pullRequest.url;
      completeObservedStep(record, "pull-request", this.#now());
      if (pullRequest.state === "merged") {
        record.state = "delivered";
        completeObservedStep(record, "verify", this.#now());
      } else if (pullRequest.state === "open") {
        record.state = "published";
      } else {
        record.state = "blocked";
        record.lastError = "The publication pull request was closed without delivery";
      }
    }
    return record;
  }

  async #reconciling(record: DurablePublicationRecord, error: unknown): Promise<DurablePublicationRecord> {
    record.state = "reconciling";
    record.updatedAt = this.#now();
    record.lastError = error instanceof Error ? error.message.slice(0, 500) : "Remote publication outcome is ambiguous";
    await this.#store.save(record);
    return structuredClone(record);
  }

  async #startStep(record: DurablePublicationRecord, step: DurablePublicationRecord["completedSteps"][number]["step"]): Promise<void> {
    record.state = "reconciling";
    record.updatedAt = this.#now();
    journal(record).push({ step, status: "started", at: record.updatedAt });
    await this.#store.save(record);
  }

  async #completeStep(record: DurablePublicationRecord, step: DurablePublicationRecord["completedSteps"][number]["step"]): Promise<void> {
    const at = this.#now();
    completeObservedStep(record, step, at);
    record.updatedAt = at;
    await this.#store.save(record);
  }

  async #required(publicationId: string): Promise<DurablePublicationRecord> {
    validateIdentifier(publicationId, "publication ID");
    const record = await this.#store.load(publicationId);
    if (!record) throw new Error(`publication not found: ${publicationId}`);
    return record;
  }
}

function remoteInput(record: DurablePublicationRecord) {
  return { repositoryUrl: record.repositoryUrl, branch: record.branch, marker: record.marker };
}

function hasStep(record: DurablePublicationRecord, step: DurablePublicationRecord["completedSteps"][number]["step"]): boolean {
  return record.completedSteps.some((completed) => completed.step === step);
}

function addStep(record: DurablePublicationRecord, step: DurablePublicationRecord["completedSteps"][number]["step"], completedAt: string): void {
  if (!hasStep(record, step)) record.completedSteps.push({ step, completedAt });
}

function journal(record: DurablePublicationRecord): DurablePublicationRecord["stepJournal"] {
  record.stepJournal ??= [];
  return record.stepJournal;
}

function completeObservedStep(
  record: DurablePublicationRecord,
  step: DurablePublicationRecord["completedSteps"][number]["step"],
  completedAt: string,
): void {
  addStep(record, step, completedAt);
  if (!journal(record).some((entry) => entry.step === step && entry.status === "completed")) {
    journal(record).push({ step, status: "completed", at: completedAt });
  }
}

function validateBasis(basis: DurablePublicationBasis): void {
  for (const [name, value] of [
    ["basis ID", basis.id],
    ["Workspace Tree ID", basis.workspaceTreeId],
    ["Repository Anchor ID", basis.repositoryAnchorId],
    ["review ID", basis.reviewId],
  ] as const) {
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${name} is invalid`);
  }
  if (new Set(basis.checkReceiptIds).size !== basis.checkReceiptIds.length) throw new Error("publication check receipts must be unique");
  for (const checkId of basis.checkReceiptIds) validateIdentifier(checkId, "check receipt ID");
}

function validateIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)) throw new Error(`${name} is invalid`);
}
