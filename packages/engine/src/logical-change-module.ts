export type LogicalChangeLifecycle = "active" | "paused" | "abandoned" | "delivered";
export type FragmentAssignmentMode = "explicit" | "session" | "lineage" | "inferred" | "unassigned";
export type WorkFragmentActor = "manual" | "agent";

export interface LogicalChangeRecord {
  id: string;
  kind: "unassigned" | "declared";
  title: string;
  lifecycle: LogicalChangeLifecycle;
  fragmentIds: string[];
  createdAt: string;
  updatedAt: string;
  splitFrom?: string;
  combinedFrom?: string[];
  supersededBy?: string;
}

export interface WorkFragmentRecord {
  id: string;
  paths: string[];
  changeId: string;
  actor: WorkFragmentActor;
  sessionId?: string;
  assignment: {
    mode: FragmentAssignmentMode;
    confidence: number;
    reason: string;
  };
}

export type RecoveryAnchorTrigger =
  | "coherent-action"
  | "meaningful-volume"
  | "checks-passed"
  | "before-risky-operation"
  | "manual-mark"
  | "before-restore"
  | "before-publication"
  | "abandon";

export interface RecoveryAnchorRecord {
  id: string;
  workspaceTreeId: string;
  changeIds: string[];
  trigger: RecoveryAnchorTrigger;
  createdAt: string;
  label?: string;
  retention: {
    /** Anchor-index discoverability only; backing ciphertext GC is owned by a snapshot Adapter. */
    class: "rolling" | "milestone" | "pinned" | "publication";
    expiresAt: string | null;
  };
  restorable: boolean;
  sourceReference?: string;
}

export interface RecoveryAnchorOwnershipState {
  unassignedChangeId: string;
  changes: LogicalChangeRecord[];
  fragments: WorkFragmentRecord[];
  sessionFocus: Array<{ sessionId: string; changeId: string }>;
}

export interface PersistedRecoveryAnchorRecord extends RecoveryAnchorRecord {
  /** Exact Logical Change organization bound to the anchored Source State. */
  ownershipState?: RecoveryAnchorOwnershipState;
}

export interface RestorePreviewRecord {
  id: string;
  anchorId: string;
  fromWorkspaceTreeId: string;
  toWorkspaceTreeId: string;
  createdAt: string;
  expiresAt: string;
  sourceReference?: string;
}

export interface ReviewBindingRecord {
  id: string;
  workspaceTreeId: string;
  repositoryAnchorId: string;
  status: "fresh" | "stale";
  recordedAt: string;
}

export interface CheckBindingRecord {
  receiptIds: string[];
  workspaceTreeId: string;
  repositoryAnchorId: string;
  status: "passed" | "unchecked" | "failed" | "stale";
  recordedAt: string;
}

export interface LogicalChangeWorkspaceView {
  workspaceId: string;
  revision: number;
  unassignedChangeId: string;
  changes: LogicalChangeRecord[];
  fragments: WorkFragmentRecord[];
  currentWorkspaceTreeId?: string;
  currentSourceReference?: string;
  currentRepositoryAnchorId?: string;
  review?: ReviewBindingRecord;
  checks?: CheckBindingRecord;
  recoveryAnchors: RecoveryAnchorRecord[];
  restorePreviews: RestorePreviewRecord[];
}

export type LogicalChangeAction =
  | { requestId: string; kind: "create"; title: string }
  | { requestId: string; kind: "name"; changeId: string; title: string }
  | { requestId: string; kind: "focus"; changeId: string; sessionId: string }
  | { requestId: string; kind: "assign"; fragmentIds: string[]; toChangeId: string }
  | {
      requestId: string;
      kind: "split";
      changeId: string;
      parts: Array<{ title: string; fragmentIds: string[] }>;
      remainder: "keep" | "move-to-unassigned";
    }
  | { requestId: string; kind: "combine"; changeIds: string[]; title: string }
  | { requestId: string; kind: "transition"; changeId: string; to: LogicalChangeLifecycle }
  | { requestId: string; kind: "mark-moment"; label?: string }
  | { requestId: string; kind: "before-risky-operation"; label?: string }
  | { requestId: string; kind: "restore.preview"; anchorId: string }
  | {
      requestId: string;
      kind: "restore.apply";
      previewId: string;
      confirmation: "restore-previewed-source";
    }
  | { requestId: string; kind: "record-review"; reviewId: string; workspaceTreeId: string; repositoryAnchorId: string }
  | { requestId: string; kind: "record-checks"; receiptIds: string[]; status: "passed" | "unchecked" | "failed"; workspaceTreeId: string; repositoryAnchorId: string }
  | { requestId: string; kind: "before-publication"; allowUnchecked?: boolean };

export interface SynchronizeLogicalChangesInput {
  requestId: string;
  source?: {
    workspaceTreeId: string;
    sourceReference?: string;
    repositoryAnchorId?: string;
    /** Explicitly distinguishes metadata-only Git movement from a changed integration basis. */
    repositoryMovement?: "harmless" | "integration";
    changedLines: number;
    cause: "filesystem-change" | RecoveryAnchorTrigger;
  };
  fragments: Array<{ id: string; paths: string[]; actor?: WorkFragmentActor; sessionId?: string; parentFragmentId?: string; assignment?: "automatic" | "unassigned" }>;
}

export interface LogicalChangeModuleOptions {
  workspaceId: string;
  now?: () => string;
  nextId?: (prefix: string) => string;
  initialState?: LogicalChangeModuleState;
  initialUnassignedChangeId?: string;
}

interface RequestReceipt {
  canonicalInput: string;
  view: LogicalChangeWorkspaceView;
}

export interface LogicalChangeModuleState {
  version: 1;
  workspaceId: string;
  revision: number;
  unassignedChangeId: string;
  currentWorkspaceTreeId?: string;
  currentSourceReference?: string;
  currentRepositoryAnchorId?: string;
  review?: ReviewBindingRecord;
  checks?: CheckBindingRecord;
  changes: LogicalChangeRecord[];
  fragments: WorkFragmentRecord[];
  sessionFocus: Array<{ sessionId: string; changeId: string }>;
  recoveryAnchors: PersistedRecoveryAnchorRecord[];
  restorePreviews: RestorePreviewRecord[];
  requests: Array<{ requestId: string; canonicalInput: string; view: LogicalChangeWorkspaceView }>;
}

/**
 * Owns Logical Change organization rules behind one in-process seam. Source
 * capture, persistence, Git, GitHub, and analysis are adapters added around
 * this domain module; callers never reproduce ownership or lifecycle rules.
 */
export class LogicalChangeModule {
  readonly workspaceId: string;
  readonly #now: () => string;
  readonly #nextId: (prefix: string) => string;
  readonly #changes = new Map<string, LogicalChangeRecord>();
  readonly #fragments = new Map<string, WorkFragmentRecord>();
  readonly #sessionFocus = new Map<string, string>();
  readonly #requests = new Map<string, RequestReceipt>();
  readonly #recoveryAnchors = new Map<string, PersistedRecoveryAnchorRecord>();
  readonly #restorePreviews = new Map<string, RestorePreviewRecord>();
  #revision = 0;
  #unassignedChangeId!: string;
  #currentWorkspaceTreeId: string | undefined;
  #currentSourceReference: string | undefined;
  #currentRepositoryAnchorId: string | undefined;
  #review: ReviewBindingRecord | undefined;
  #checks: CheckBindingRecord | undefined;

  constructor(options: LogicalChangeModuleOptions) {
    if (!options.workspaceId.trim()) throw new Error("workspace ID is required");
    this.workspaceId = options.workspaceId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nextId = options.nextId ?? ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`);
    if (options.initialState) this.#restoreState(options.initialState);
    else {
      const unassigned = this.#newChange("unassigned", "Unassigned Change", {}, options.initialUnassignedChangeId);
      this.#unassignedChangeId = unassigned.id;
    }
  }

  read(): LogicalChangeWorkspaceView {
    return cloneView({
      workspaceId: this.workspaceId,
      revision: this.#revision,
      unassignedChangeId: this.#unassignedChangeId,
      changes: [...this.#changes.values()],
      fragments: [...this.#fragments.values()],
      ...(this.#currentWorkspaceTreeId === undefined ? {} : { currentWorkspaceTreeId: this.#currentWorkspaceTreeId }),
      ...(this.#currentSourceReference === undefined ? {} : { currentSourceReference: this.#currentSourceReference }),
      ...(this.#currentRepositoryAnchorId === undefined ? {} : { currentRepositoryAnchorId: this.#currentRepositoryAnchorId }),
      ...(this.#review === undefined ? {} : { review: this.#review }),
      ...(this.#checks === undefined ? {} : { checks: this.#checks }),
      recoveryAnchors: [...this.#recoveryAnchors.values()].map((anchor) => this.#anchorForRead(anchor)),
      restorePreviews: [...this.#restorePreviews.values()].filter((preview) => this.#restorePreviewAvailable(preview)),
    });
  }

  exportState(): LogicalChangeModuleState {
    return structuredClone({
      version: 1,
      workspaceId: this.workspaceId,
      revision: this.#revision,
      unassignedChangeId: this.#unassignedChangeId,
      ...(this.#currentWorkspaceTreeId === undefined ? {} : { currentWorkspaceTreeId: this.#currentWorkspaceTreeId }),
      ...(this.#currentSourceReference === undefined ? {} : { currentSourceReference: this.#currentSourceReference }),
      ...(this.#currentRepositoryAnchorId === undefined ? {} : { currentRepositoryAnchorId: this.#currentRepositoryAnchorId }),
      ...(this.#review === undefined ? {} : { review: this.#review }),
      ...(this.#checks === undefined ? {} : { checks: this.#checks }),
      changes: [...this.#changes.values()],
      fragments: [...this.#fragments.values()],
      sessionFocus: [...this.#sessionFocus].map(([sessionId, changeId]) => ({ sessionId, changeId })),
      recoveryAnchors: [...this.#recoveryAnchors.values()],
      restorePreviews: [...this.#restorePreviews.values()],
      requests: [...this.#requests].map(([requestId, receipt]) => ({ requestId, ...receipt })),
    });
  }

  act(input: LogicalChangeAction): LogicalChangeWorkspaceView {
    const before = this.exportState();
    try { return this.#exactlyOnce(input.requestId, input, () => {
      switch (input.kind) {
        case "create":
          this.#newChange("declared", validatedTitle(input.title));
          break;
        case "name":
          this.#name(input.changeId, input.title);
          break;
        case "focus":
          this.#focus(input.changeId, input.sessionId);
          break;
        case "assign":
          this.#assign(input.fragmentIds, input.toChangeId, "explicit", 1, "Explicit assignment");
          break;
        case "split":
          this.#split(input);
          break;
        case "combine":
          this.#combine(input.changeIds, input.title);
          break;
        case "transition":
          this.#transition(input.changeId, input.to);
          break;
        case "mark-moment":
          this.#createAnchor("manual-mark", input.label);
          break;
        case "before-risky-operation":
          this.#createAnchor("before-risky-operation", input.label);
          break;
        case "restore.preview":
          this.#previewRestore(input.anchorId);
          break;
        case "restore.apply":
          this.#applyRestore(input.previewId, input.confirmation);
          break;
        case "record-review":
          this.#recordReview(input);
          break;
        case "record-checks":
          this.#recordChecks(input);
          break;
        case "before-publication":
          this.#assertFreshEvidence(input.allowUnchecked === true);
          this.#createAnchor("before-publication");
          break;
      }
      this.#revision += 1;
      return this.read();
    }); } catch (error) { this.#restoreState(before); throw error; }
  }

  synchronize(input: SynchronizeLogicalChangesInput): LogicalChangeWorkspaceView {
    const before = this.exportState();
    try { return this.#exactlyOnce(input.requestId, input, () => {
      const observedIds = new Set<string>();
      for (const observed of input.fragments) {
        if (!observed.id.trim() || observedIds.has(observed.id)) throw new Error("observed fragment IDs must be non-empty and unique");
        observedIds.add(observed.id);
        const paths = normalizePaths(observed.paths);
        const actor = observed.actor ?? (observed.sessionId === undefined ? "manual" : "agent");
        const existing = this.#fragments.get(observed.id);
        if (existing) {
          existing.paths = paths;
          continue;
        }

        const forceUnassigned = observed.assignment === "unassigned";
        const lineage = forceUnassigned || !observed.parentFragmentId ? undefined : this.#fragments.get(observed.parentFragmentId);
        const focusedId = forceUnassigned || !observed.sessionId ? undefined : this.#sessionFocus.get(observed.sessionId);
        const focused = focusedId ? this.#assignableChange(focusedId) : undefined;
        const inferred = forceUnassigned || focused ? undefined : this.#inferByPath(paths);
        const changeId = focused?.id
          ?? (lineage && this.#assignableChange(lineage.changeId) ? lineage.changeId : undefined)
          ?? inferred?.change.id
          ?? this.#unassignedChangeId;
        const assignment: WorkFragmentRecord["assignment"] = focused
          ? { mode: "session", confidence: 1, reason: `Focused work session ${observed.sessionId}` }
          : lineage && this.#assignableChange(lineage.changeId)
            ? { mode: "lineage", confidence: 1, reason: `Continues ${lineage.id}` }
            : inferred
              ? { mode: "inferred", confidence: inferred.confidence, reason: inferred.reason }
              : { mode: "unassigned", confidence: 0, reason: "No unique active Logical Change matched" };
        const fragment: WorkFragmentRecord = {
          id: observed.id,
          paths,
          changeId,
          actor,
          ...(observed.sessionId === undefined ? {} : { sessionId: observed.sessionId }),
          assignment,
        };
        this.#fragments.set(fragment.id, fragment);
        this.#change(changeId).fragmentIds.push(fragment.id);
      }
      for (const fragment of [...this.#fragments.values()]) {
        if (observedIds.has(fragment.id)) continue;
        const owner = this.#change(fragment.changeId);
        owner.fragmentIds = owner.fragmentIds.filter((id) => id !== fragment.id);
        owner.updatedAt = this.#now();
        this.#fragments.delete(fragment.id);
      }
      if (input.source) this.#synchronizeSource(input.source);
      this.#revision += 1;
      return this.read();
    }); } catch (error) { this.#restoreState(before); throw error; }
  }

  #name(changeId: string, title: string): void {
    const change = this.#change(changeId);
    if (change.lifecycle !== "active") throw new Error(`cannot name ${change.lifecycle} Logical Change`);
    change.title = validatedTitle(title);
    change.kind = "declared";
    change.updatedAt = this.#now();
    if (change.id === this.#unassignedChangeId) {
      this.#unassignedChangeId = this.#newChange("unassigned", "Unassigned Change").id;
    }
  }

  #focus(changeId: string, sessionId: string): void {
    if (!sessionId.trim()) throw new Error("work session ID is required");
    const change = this.#assignableChange(changeId);
    if (!change || change.kind === "unassigned") throw new Error("only an active declared Logical Change can receive focus");
    this.#sessionFocus.set(sessionId, change.id);
  }

  #assign(fragmentIds: string[], toChangeId: string, mode: FragmentAssignmentMode, confidence: number, reason: string): void {
    if (fragmentIds.length === 0 || new Set(fragmentIds).size !== fragmentIds.length) throw new Error("fragment assignment must contain unique fragments");
    const destination = this.#assignableChange(toChangeId);
    if (!destination) throw new Error("destination Logical Change must be active");
    const fragments = fragmentIds.map((fragmentId) => this.#fragment(fragmentId));
    for (const fragment of fragments) {
      const previous = this.#change(fragment.changeId);
      previous.fragmentIds = previous.fragmentIds.filter((id) => id !== fragment.id);
      previous.updatedAt = this.#now();
      fragment.changeId = destination.id;
      fragment.assignment = { mode, confidence, reason };
      if (!destination.fragmentIds.includes(fragment.id)) destination.fragmentIds.push(fragment.id);
    }
    destination.updatedAt = this.#now();
  }

  #split(input: Extract<LogicalChangeAction, { kind: "split" }>): void {
    const source = this.#assignableChange(input.changeId);
    if (!source || source.kind === "unassigned") throw new Error("only an active declared Logical Change can be split");
    if (input.parts.length < 2) throw new Error("split requires at least two parts");
    const selected = input.parts.flatMap((part) => part.fragmentIds);
    if (selected.length === 0 || new Set(selected).size !== selected.length) throw new Error("split fragments must be unique");
    if (selected.some((fragmentId) => this.#fragment(fragmentId).changeId !== source.id)) throw new Error("split fragments must belong to the source Logical Change");

    for (const part of input.parts) {
      if (part.fragmentIds.length === 0) throw new Error("each split part requires at least one fragment");
      const created = this.#newChange("declared", validatedTitle(part.title), { splitFrom: source.id });
      this.#assign(part.fragmentIds, created.id, "explicit", 1, `Split from ${source.id}`);
    }
    if (input.remainder === "move-to-unassigned" && source.fragmentIds.length > 0) {
      this.#assign([...source.fragmentIds], this.#unassignedChangeId, "unassigned", 0, `Remainder split from ${source.id}`);
    }
    if (source.fragmentIds.length === 0) this.#setSuperseded(source);
  }

  #combine(changeIds: string[], title: string): void {
    if (changeIds.length < 2 || new Set(changeIds).size !== changeIds.length) throw new Error("combine requires at least two unique Logical Changes");
    const sources = changeIds.map((changeId) => {
      const change = this.#assignableChange(changeId);
      if (!change || change.kind === "unassigned") throw new Error("only active declared Logical Changes can be combined");
      return change;
    });
    const combined = this.#newChange("declared", validatedTitle(title), { combinedFrom: [...changeIds] });
    for (const source of sources) {
      if (source.fragmentIds.length > 0) this.#assign([...source.fragmentIds], combined.id, "explicit", 1, `Combined from ${source.id}`);
      this.#setSuperseded(source, combined.id);
    }
  }

  #transition(changeId: string, to: LogicalChangeLifecycle): void {
    const change = this.#change(changeId);
    if (change.kind === "unassigned") throw new Error("Unassigned Change cannot transition lifecycle");
    const allowed: Record<LogicalChangeLifecycle, LogicalChangeLifecycle[]> = {
      active: ["paused", "abandoned", "delivered"],
      paused: ["active", "abandoned"],
      abandoned: [],
      delivered: [],
    };
    if (!allowed[change.lifecycle].includes(to)) throw new Error(`${change.lifecycle} Logical Change cannot transition to ${to}`);
    if (to === "abandoned" && this.#currentWorkspaceTreeId) this.#createAnchor("abandon");
    change.lifecycle = to;
    change.updatedAt = this.#now();
    if (to !== "active") this.#clearFocus(change.id);
    if (to === "abandoned" && change.fragmentIds.length > 0) {
      this.#assign([...change.fragmentIds], this.#unassignedChangeId, "unassigned", 0, `Released by abandoned ${change.id}`);
    }
  }

  #synchronizeSource(source: NonNullable<SynchronizeLogicalChangesInput["source"]>): void {
    assertWorkspaceTreeId(source.workspaceTreeId);
    if (!Number.isInteger(source.changedLines) || source.changedLines < 0) throw new Error("changed line count must be a non-negative integer");
    if (source.repositoryAnchorId !== undefined) assertWorkspaceTreeId(source.repositoryAnchorId);
    if (source.repositoryMovement !== undefined && source.repositoryMovement !== "harmless" && source.repositoryMovement !== "integration") throw new Error("repository movement is invalid");
    const changed = source.workspaceTreeId !== this.#currentWorkspaceTreeId;
    const repositoryChanged = source.repositoryAnchorId !== undefined && source.repositoryAnchorId !== this.#currentRepositoryAnchorId;
    this.#currentWorkspaceTreeId = source.workspaceTreeId;
    if (source.sourceReference !== undefined) {
      if (!validSourceReference(source.sourceReference)) throw new Error("Source State reference is invalid");
      this.#currentSourceReference = source.sourceReference;
    }
    if (source.repositoryAnchorId !== undefined) this.#currentRepositoryAnchorId = source.repositoryAnchorId;
    if (changed || (repositoryChanged && source.repositoryMovement !== "harmless")) this.#markEvidenceStale();
    else if (repositoryChanged) {
      if (this.#review) this.#review.repositoryAnchorId = source.repositoryAnchorId!;
      if (this.#checks) this.#checks.repositoryAnchorId = source.repositoryAnchorId!;
    }
    if (source.cause !== "filesystem-change"
      && (source.cause !== "meaningful-volume" || source.changedLines >= 50)) {
      this.#createAnchor(source.cause);
    }
  }

  #createAnchor(trigger: RecoveryAnchorTrigger, label?: string): RecoveryAnchorRecord {
    if (!this.#currentWorkspaceTreeId) throw new Error("a Source State is required before creating a Recovery Anchor");
    const normalizedLabel = label?.trim();
    if (label !== undefined && (!normalizedLabel || normalizedLabel.length > 120)) throw new Error("Recovery Anchor label must be between 1 and 120 characters");
    const ownershipState = this.#captureOwnershipState();
    if (trigger !== "manual-mark") {
      const duplicate = [...this.#recoveryAnchors.values()].find((anchor) =>
        anchor.workspaceTreeId === this.#currentWorkspaceTreeId
          && anchor.trigger === trigger
          && JSON.stringify(anchor.ownershipState) === JSON.stringify(ownershipState),
      );
      if (duplicate) return duplicate;
    }
    const createdAt = this.#now();
    const retention = retentionFor(trigger, createdAt);
    const anchor: PersistedRecoveryAnchorRecord = {
      id: this.#nextId("anchor"),
      workspaceTreeId: this.#currentWorkspaceTreeId,
      changeIds: [...this.#changes.values()].filter((change) => change.fragmentIds.length > 0).map((change) => change.id),
      trigger,
      createdAt,
      ...(normalizedLabel === undefined ? {} : { label: normalizedLabel }),
      retention,
      restorable: validSourceReference(this.#currentSourceReference),
      ...(this.#currentSourceReference === undefined ? {} : { sourceReference: this.#currentSourceReference }),
      ownershipState,
    };
    this.#recoveryAnchors.set(anchor.id, anchor);
    this.#compactRollingAnchorMetadata();
    return anchor;
  }

  /** Compacts the anchor index only. Encrypted snapshot byte GC is an Adapter responsibility. */
  #compactRollingAnchorMetadata(): void {
    const rolling = [...this.#recoveryAnchors.values()].filter((anchor) => anchor.retention.class === "rolling");
    while (rolling.length > 20) {
      const oldest = rolling.shift()!;
      this.#recoveryAnchors.delete(oldest.id);
    }
  }

  #anchorForRead(anchor: RecoveryAnchorRecord): RecoveryAnchorRecord {
    const { ownershipState: _ownershipState, ...visible } = anchor as PersistedRecoveryAnchorRecord;
    return {
      ...visible,
      restorable: anchor.restorable
        && validSourceReference(anchor.sourceReference)
        && validOwnershipProjection(_ownershipState)
        && !this.#anchorExpired(anchor),
    };
  }

  #anchorExpired(anchor: RecoveryAnchorRecord): boolean {
    return anchor.retention.expiresAt !== null
      && Date.parse(this.#now()) >= Date.parse(anchor.retention.expiresAt);
  }

  #restorePreviewAvailable(preview: RestorePreviewRecord): boolean {
    if (Date.parse(this.#now()) >= Date.parse(preview.expiresAt)) return false;
    if (preview.fromWorkspaceTreeId !== this.#currentWorkspaceTreeId) return false;
    const anchor = this.#recoveryAnchors.get(preview.anchorId);
    return anchor !== undefined
      && this.#anchorRestorable(anchor)
      && preview.toWorkspaceTreeId === anchor.workspaceTreeId
      && validSourceReference(preview.sourceReference)
      && preview.sourceReference === anchor.sourceReference;
  }

  #previewRestore(anchorId: string): RestorePreviewRecord {
    if (!this.#currentWorkspaceTreeId) throw new Error("a current Source State is required before restore preview");
    const anchor = this.#recoveryAnchors.get(anchorId);
    if (!anchor || !this.#anchorHasBacking(anchor)) throw new Error(`Recovery Anchor not found or not restorable: ${anchorId}`);
    if (this.#anchorExpired(anchor)) throw new Error("Recovery Anchor has expired");
    const createdAt = this.#now();
    const preview: RestorePreviewRecord = {
      id: this.#nextId("restore"),
      anchorId: anchor.id,
      fromWorkspaceTreeId: this.#currentWorkspaceTreeId,
      toWorkspaceTreeId: anchor.workspaceTreeId,
      createdAt,
      expiresAt: addMilliseconds(createdAt, 15 * 60_000),
      sourceReference: anchor.sourceReference!,
    };
    this.#restorePreviews.set(preview.id, preview);
    return preview;
  }

  #applyRestore(previewId: string, confirmation: "restore-previewed-source"): void {
    if (confirmation !== "restore-previewed-source") throw new Error("restore requires preview confirmation");
    const preview = this.#restorePreviews.get(previewId);
    if (!preview) throw new Error(`Restore Preview not found: ${previewId}`);
    if (Date.parse(preview.expiresAt) <= Date.parse(this.#now())) throw new Error("Restore Preview is stale");
    const anchor = this.#recoveryAnchors.get(preview.anchorId);
    if (!anchor || !this.#anchorHasBacking(anchor)) throw new Error(`Recovery Anchor not found or not restorable: ${preview.anchorId}`);
    if (this.#anchorExpired(anchor)) throw new Error("Recovery Anchor has expired");
    if (preview.toWorkspaceTreeId !== anchor.workspaceTreeId
      || !validSourceReference(preview.sourceReference)
      || preview.sourceReference !== anchor.sourceReference) {
      throw new Error("Restore Preview does not match its Recovery Anchor backing");
    }
    if (this.#currentWorkspaceTreeId !== preview.fromWorkspaceTreeId) throw new Error("Restore Preview no longer matches the current Source State");
    const restoredOwnership = this.#ownershipForRestore(anchor.ownershipState!);
    this.#createAnchor("before-restore");
    this.#replaceOwnershipState(restoredOwnership);
    this.#currentWorkspaceTreeId = preview.toWorkspaceTreeId;
    this.#currentSourceReference = preview.sourceReference;
    this.#markEvidenceStale();
    this.#restorePreviews.clear();
  }

  #anchorRestorable(anchor: PersistedRecoveryAnchorRecord): boolean {
    return this.#anchorHasBacking(anchor) && !this.#anchorExpired(anchor);
  }

  #anchorHasBacking(anchor: PersistedRecoveryAnchorRecord): boolean {
    return anchor.restorable
      && validSourceReference(anchor.sourceReference)
      && validOwnershipProjection(anchor.ownershipState);
  }

  #recordReview(input: Extract<LogicalChangeAction, { kind: "record-review" }>): void {
    this.#assertCurrentBasis(input.workspaceTreeId, input.repositoryAnchorId);
    if (!input.reviewId.trim()) throw new Error("Semantic Review ID is required");
    this.#review = { id: input.reviewId, workspaceTreeId: input.workspaceTreeId, repositoryAnchorId: input.repositoryAnchorId, status: "fresh", recordedAt: this.#now() };
  }

  #recordChecks(input: Extract<LogicalChangeAction, { kind: "record-checks" }>): void {
    this.#assertCurrentBasis(input.workspaceTreeId, input.repositoryAnchorId);
    if (input.receiptIds.length === 0 || new Set(input.receiptIds).size !== input.receiptIds.length || input.receiptIds.some((id) => !id.trim())) throw new Error("Check receipt IDs must be non-empty and unique");
    this.#checks = { receiptIds: [...input.receiptIds], workspaceTreeId: input.workspaceTreeId, repositoryAnchorId: input.repositoryAnchorId, status: input.status, recordedAt: this.#now() };
    if (input.status === "passed") this.#createAnchor("checks-passed");
  }

  #assertCurrentBasis(workspaceTreeId: string, repositoryAnchorId: string): void {
    assertWorkspaceTreeId(workspaceTreeId);
    assertWorkspaceTreeId(repositoryAnchorId);
    if (workspaceTreeId !== this.#currentWorkspaceTreeId || repositoryAnchorId !== this.#currentRepositoryAnchorId) throw new Error("Evidence does not match the current Source State and repository anchor");
  }

  #assertFreshEvidence(allowUnchecked: boolean): void {
    if (this.#review?.status !== "fresh") throw new Error("Publication requires a fresh Semantic Review");
    if (this.#checks?.status !== "passed" && !(allowUnchecked && this.#checks?.status === "unchecked")) throw new Error("Publication requires fresh passing checks or explicit unchecked approval");
    this.#assertCurrentBasis(this.#review.workspaceTreeId, this.#review.repositoryAnchorId);
    this.#assertCurrentBasis(this.#checks.workspaceTreeId, this.#checks.repositoryAnchorId);
  }

  #markEvidenceStale(): void {
    if (this.#review) this.#review.status = "stale";
    if (this.#checks) this.#checks.status = "stale";
  }

  #inferByPath(paths: string[]): { change: LogicalChangeRecord; confidence: number; reason: string } | undefined {
    const candidates = [...this.#changes.values()].filter((change) => change.kind === "declared" && change.lifecycle === "active");
    const scores = candidates.map((change) => {
      const ownedPaths = new Set(change.fragmentIds.flatMap((fragmentId) => this.#fragment(fragmentId).paths));
      const overlap = paths.filter((path) => ownedPaths.has(path)).length;
      return { change, overlap };
    }).filter(({ overlap }) => overlap > 0).sort((left, right) => right.overlap - left.overlap);
    if (scores.length === 0 || (scores[1] && scores[1].overlap === scores[0]!.overlap)) return undefined;
    return {
      change: scores[0]!.change,
      confidence: Math.min(0.95, 0.6 + scores[0]!.overlap / Math.max(paths.length, 1) * 0.35),
      reason: `Unique path affinity with ${scores[0]!.change.id}`,
    };
  }

  #restoreState(state: LogicalChangeModuleState): void {
    if (state.version !== 1 || state.workspaceId !== this.workspaceId) throw new Error("Logical Change state does not match this workspace");
    this.#changes.clear();
    this.#fragments.clear();
    this.#sessionFocus.clear();
    this.#requests.clear();
    this.#recoveryAnchors.clear();
    this.#restorePreviews.clear();
    this.#currentWorkspaceTreeId = undefined;
    this.#currentSourceReference = undefined;
    this.#currentRepositoryAnchorId = undefined;
    this.#review = undefined;
    this.#checks = undefined;
    if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error("Logical Change state revision is invalid");
    this.#revision = state.revision;
    if (state.currentWorkspaceTreeId !== undefined) {
      assertWorkspaceTreeId(state.currentWorkspaceTreeId);
      this.#currentWorkspaceTreeId = state.currentWorkspaceTreeId;
    }
    if (state.currentSourceReference !== undefined) {
      if (!validSourceReference(state.currentSourceReference)) throw new Error("Logical Change current Source State reference is invalid");
      this.#currentSourceReference = state.currentSourceReference;
    }
    if (state.currentRepositoryAnchorId !== undefined) { assertWorkspaceTreeId(state.currentRepositoryAnchorId); this.#currentRepositoryAnchorId = state.currentRepositoryAnchorId; }
    if (state.review !== undefined) this.#review = structuredClone(state.review);
    if (state.checks !== undefined) this.#checks = structuredClone(state.checks);
    this.#replaceOwnershipState({
      unassignedChangeId: state.unassignedChangeId,
      changes: state.changes,
      fragments: state.fragments,
      sessionFocus: state.sessionFocus,
    });
    for (const anchor of state.recoveryAnchors) {
      assertWorkspaceTreeId(anchor.workspaceTreeId);
      if (this.#recoveryAnchors.has(anchor.id)) throw new Error("Logical Change state contains duplicate Recovery Anchors");
      this.#recoveryAnchors.set(anchor.id, structuredClone(anchor));
    }
    for (const preview of state.restorePreviews) {
      assertWorkspaceTreeId(preview.fromWorkspaceTreeId);
      assertWorkspaceTreeId(preview.toWorkspaceTreeId);
      if (!this.#recoveryAnchors.has(preview.anchorId) || this.#restorePreviews.has(preview.id)) throw new Error("Logical Change Restore Preview state is invalid");
      this.#restorePreviews.set(preview.id, structuredClone(preview));
    }
    for (const request of state.requests) {
      if (!request.requestId || this.#requests.has(request.requestId)) throw new Error("Logical Change request receipt state is invalid");
      this.#requests.set(request.requestId, { canonicalInput: request.canonicalInput, view: cloneView(request.view) });
    }
  }

  #captureOwnershipState(): RecoveryAnchorOwnershipState {
    return structuredClone({
      unassignedChangeId: this.#unassignedChangeId,
      changes: [...this.#changes.values()],
      fragments: [...this.#fragments.values()],
      sessionFocus: [...this.#sessionFocus].map(([sessionId, changeId]) => ({ sessionId, changeId })),
    });
  }

  #ownershipForRestore(anchored: RecoveryAnchorOwnershipState): RecoveryAnchorOwnershipState {
    const anchoredChangeIds = new Set(anchored.changes.map((change) => change.id));
    const preservedChanges = [...this.#changes.values()]
      .filter((change) => change.kind === "declared" && !anchoredChangeIds.has(change.id))
      .map((change) => ({ ...structuredClone(change), fragmentIds: [] }));
    const preservedChangeIds = new Set(preservedChanges.map((change) => change.id));
    const anchoredSessions = new Set(anchored.sessionFocus.map((focus) => focus.sessionId));
    const preservedFocus = [...this.#sessionFocus]
      .filter(([sessionId, changeId]) => !anchoredSessions.has(sessionId) && preservedChangeIds.has(changeId))
      .map(([sessionId, changeId]) => ({ sessionId, changeId }));
    return structuredClone({
      ...anchored,
      changes: [...anchored.changes, ...preservedChanges],
      sessionFocus: [...anchored.sessionFocus, ...preservedFocus],
    });
  }

  #replaceOwnershipState(state: RecoveryAnchorOwnershipState): void {
    const changes = new Map<string, LogicalChangeRecord>();
    for (const change of state.changes) {
      if (changes.has(change.id)) throw new Error("Logical Change state contains duplicate changes");
      changes.set(change.id, structuredClone(change));
    }
    const unassigned = changes.get(state.unassignedChangeId);
    if (!unassigned || unassigned.kind !== "unassigned" || unassigned.lifecycle !== "active"
      || state.changes.filter((change) => change.kind === "unassigned" && change.lifecycle === "active").length !== 1) {
      throw new Error("Logical Change state must contain exactly one active Unassigned Change");
    }
    const fragments = new Map<string, WorkFragmentRecord>();
    for (const fragment of state.fragments) {
      if (fragments.has(fragment.id) || !changes.has(fragment.changeId)) throw new Error("Logical Change state fragment ownership is invalid");
      normalizePaths(fragment.paths);
      const actor = fragment.actor ?? (fragment.sessionId === undefined ? "manual" : "agent");
      if (actor !== "manual" && actor !== "agent") throw new Error("Logical Change state fragment actor is invalid");
      fragments.set(fragment.id, { ...structuredClone(fragment), actor });
    }
    const referenced = state.changes.flatMap((change) => change.fragmentIds);
    if (referenced.length !== fragments.size || new Set(referenced).size !== referenced.length
      || referenced.some((fragmentId) => !fragments.has(fragmentId))
      || state.changes.some((change) => change.fragmentIds.some((fragmentId) => fragments.get(fragmentId)?.changeId !== change.id))) {
      throw new Error("Logical Change state violates exactly-one fragment ownership");
    }
    const sessionFocus = new Map<string, string>();
    for (const focus of state.sessionFocus) {
      const focused = changes.get(focus.changeId);
      if (!focus.sessionId || focused?.lifecycle !== "active" || sessionFocus.has(focus.sessionId)) throw new Error("Logical Change focus state is invalid");
      sessionFocus.set(focus.sessionId, focus.changeId);
    }
    this.#changes.clear();
    this.#fragments.clear();
    this.#sessionFocus.clear();
    for (const [id, change] of changes) this.#changes.set(id, change);
    for (const [id, fragment] of fragments) this.#fragments.set(id, fragment);
    for (const [sessionId, changeId] of sessionFocus) this.#sessionFocus.set(sessionId, changeId);
    this.#unassignedChangeId = state.unassignedChangeId;
  }

  #setSuperseded(change: LogicalChangeRecord, supersededBy?: string): void {
    change.lifecycle = "abandoned";
    change.updatedAt = this.#now();
    this.#clearFocus(change.id);
    if (supersededBy !== undefined) change.supersededBy = supersededBy;
  }

  #clearFocus(changeId: string): void {
    for (const [sessionId, focusedId] of this.#sessionFocus) {
      if (focusedId === changeId) this.#sessionFocus.delete(sessionId);
    }
  }

  #assignableChange(changeId: string): LogicalChangeRecord | undefined {
    const change = this.#changes.get(changeId);
    return change?.lifecycle === "active" ? change : undefined;
  }

  #newChange(
    kind: LogicalChangeRecord["kind"],
    title: string,
    lineage: Pick<LogicalChangeRecord, "splitFrom" | "combinedFrom"> = {},
    suppliedId?: string,
  ): LogicalChangeRecord {
    const at = this.#now();
    const change: LogicalChangeRecord = {
      id: suppliedId ?? this.#nextId("change"),
      kind,
      title,
      lifecycle: "active",
      fragmentIds: [],
      createdAt: at,
      updatedAt: at,
      ...(lineage.splitFrom === undefined ? {} : { splitFrom: lineage.splitFrom }),
      ...(lineage.combinedFrom === undefined ? {} : { combinedFrom: lineage.combinedFrom }),
    };
    if (!change.id.trim() || this.#changes.has(change.id)) throw new Error("Logical Change ID must be non-empty and unique");
    this.#changes.set(change.id, change);
    return change;
  }

  #change(changeId: string): LogicalChangeRecord {
    const change = this.#changes.get(changeId);
    if (!change) throw new Error(`Logical Change not found: ${changeId}`);
    return change;
  }

  #fragment(fragmentId: string): WorkFragmentRecord {
    const fragment = this.#fragments.get(fragmentId);
    if (!fragment) throw new Error(`work fragment not found: ${fragmentId}`);
    return fragment;
  }

  #exactlyOnce<T extends { requestId: string }>(requestId: string, input: T, operation: () => LogicalChangeWorkspaceView): LogicalChangeWorkspaceView {
    if (!requestId.trim()) throw new Error("request ID is required");
    const canonicalInput = JSON.stringify(input);
    const existing = this.#requests.get(requestId);
    if (existing) {
      if (existing.canonicalInput !== canonicalInput) throw new Error("request ID was already used with different input");
      return cloneView(existing.view);
    }
    const view = operation();
    this.#requests.set(requestId, { canonicalInput, view: cloneView(view) });
    return cloneView(view);
  }
}

function normalizePaths(paths: string[]): string[] {
  if (paths.length === 0) throw new Error("work fragment requires at least one path");
  const normalized = paths.map((path) => path.trim());
  if (normalized.some((path) => !path || path.startsWith("/") || path.includes("..")) || new Set(normalized).size !== normalized.length) {
    throw new Error("work fragment paths must be unique safe relative paths");
  }
  return normalized;
}

function validatedTitle(title: string): string {
  const value = title.trim();
  if (value.length < 3 || value.length > 120) throw new Error("Logical Change title must be between 3 and 120 characters");
  return value;
}

function cloneView(view: LogicalChangeWorkspaceView): LogicalChangeWorkspaceView {
  return structuredClone(view);
}

function assertWorkspaceTreeId(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error("Workspace Tree ID is invalid");
}

function validSourceReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
}

function validOwnershipProjection(value: unknown): value is RecoveryAnchorOwnershipState {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const projection = value as Partial<RecoveryAnchorOwnershipState>;
    if (typeof projection.unassignedChangeId !== "string"
      || !Array.isArray(projection.changes)
      || !Array.isArray(projection.fragments)
      || !Array.isArray(projection.sessionFocus)) return false;

    const changes = new Map<string, LogicalChangeRecord>();
    for (const candidate of projection.changes) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const change = candidate as LogicalChangeRecord;
      if (typeof change.id !== "string" || changes.has(change.id)
        || !["unassigned", "declared"].includes(change.kind)
        || !["active", "paused", "abandoned", "delivered"].includes(change.lifecycle)
        || !Array.isArray(change.fragmentIds)
        || change.fragmentIds.some((id) => typeof id !== "string")) return false;
      changes.set(change.id, change);
    }
    const unassigned = changes.get(projection.unassignedChangeId);
    if (!unassigned || unassigned.kind !== "unassigned" || unassigned.lifecycle !== "active"
      || projection.changes.filter((change) => change.kind === "unassigned" && change.lifecycle === "active").length !== 1) return false;

    const fragments = new Map<string, WorkFragmentRecord>();
    for (const candidate of projection.fragments) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const fragment = candidate as WorkFragmentRecord;
      if (typeof fragment.id !== "string" || typeof fragment.changeId !== "string"
        || fragments.has(fragment.id) || !changes.has(fragment.changeId)
        || !Array.isArray(fragment.paths) || fragment.paths.some((entry) => typeof entry !== "string")) return false;
      normalizePaths(fragment.paths);
      const actor = fragment.actor ?? (fragment.sessionId === undefined ? "manual" : "agent");
      if (actor !== "manual" && actor !== "agent") return false;
      fragments.set(fragment.id, fragment);
    }
    const referenced = projection.changes.flatMap((change) => change.fragmentIds);
    if (referenced.length !== fragments.size || new Set(referenced).size !== referenced.length
      || referenced.some((fragmentId) => !fragments.has(fragmentId))
      || projection.changes.some((change) => change.fragmentIds.some((fragmentId) => fragments.get(fragmentId)?.changeId !== change.id))) return false;

    const sessions = new Set<string>();
    for (const candidate of projection.sessionFocus) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const focus = candidate as { sessionId?: unknown; changeId?: unknown };
      const focused = typeof focus.changeId === "string" ? changes.get(focus.changeId) : undefined;
      if (typeof focus.sessionId !== "string" || !focus.sessionId || sessions.has(focus.sessionId) || focused?.lifecycle !== "active") return false;
      sessions.add(focus.sessionId);
    }
    return true;
  } catch {
    return false;
  }
}

function retentionFor(trigger: RecoveryAnchorTrigger, createdAt: string): RecoveryAnchorRecord["retention"] {
  if (trigger === "manual-mark") return { class: "pinned", expiresAt: null };
  if (trigger === "before-publication") return { class: "publication", expiresAt: null };
  if (trigger === "coherent-action" || trigger === "meaningful-volume") {
    return { class: "rolling", expiresAt: addMilliseconds(createdAt, 7 * 24 * 60 * 60_000) };
  }
  return { class: "milestone", expiresAt: addMilliseconds(createdAt, 30 * 24 * 60 * 60_000) };
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}
