import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { SnapshotRecord } from "@veil/contracts";
import { createSafeRunRoot, readSafeRunRoot, safeRemoveRunPath, type SafeRunRoot } from "./cleanup.js";
import { EncryptedSnapshotStore } from "./snapshot.js";
import { assertSafeId, newId } from "./util.js";

/**
 * A host-consumable editor target.  These are deliberately data-only: the host
 * may invoke its editor integration, but this package never builds or executes
 * a shell command from a path.
 */
export interface ManualLaunchDescriptor {
  kind: "vscode" | "cursor" | "terminal" | "copy-path";
  directory: string;
}

export interface OpenManualSnapshotViewOptions {
  /** Directory controlled by the host; one short-lived directory is made below it. */
  viewsDirectory: string;
  masterKey: Buffer;
  changeId: string;
  snapshotId: string;
  actorIdentityId: string;
  /**
   * The application must enforce its tenant/change access policy here.  The
   * engine then independently verifies the record and all of its parents.
   */
  authorizeSnapshot(snapshot: SnapshotRecord): Promise<boolean> | boolean;
  excludedPaths?: string[];
}

/** Durable data needed to resume a guarded manual view in a new process. */
export interface ResumeManualSnapshotViewOptions extends OpenManualSnapshotViewOptions {
  runRootPath: string;
  runRootToken: string;
  directory: string;
  latestSnapshotId?: string;
}

export interface CaptureManualSnapshotOptions {
  eventSequence: number;
  evidenceObjectIds?: string[];
  now?: Date;
  /** Defaults to the snapshot used to open this view. */
  parent?: "source" | "latest-autosnapshot";
}

export interface StartManualAutosnapshotsOptions {
  /** Milliseconds to wait after the most recent filesystem hint. Defaults to 2 seconds. */
  debounceMs?: number;
  /**
   * Called inside the per-view capture queue immediately before each capture.
   * Supplying an allocator prevents a watcher and an explicit final capture
   * from racing on application event-sequence allocation.
   */
  eventSequence: number | (() => number | Promise<number>);
  evidenceObjectIds?: string[];
  /** Injectable wall clock for deterministic callers and tests. */
  now?: () => Date;
  /** Invoked only after an immutable checkpoint was committed. */
  onCaptured?: (snapshot: SnapshotRecord) => Promise<void> | void;
}

export interface ManualAutosnapshotStatus {
  active: boolean;
  pending: boolean;
  capturing: boolean;
  state: "stopped" | "waiting" | "capturing" | "error";
  latestSnapshot: SnapshotRecord | null;
  lastError: string | null;
}

const FORBIDDEN_WORKSPACE_PATH = /(^|\/)(?:\.git|\.veil|\.env(?:\..*)?|\.aws|\.ssh|\.veil-state|\.veil-runs)(?:\/|$)|(?:^|\/)(?:id_rsa|credentials)(?:$|\/)|\.(?:pem|key|p12|pfx)$/i;

/**
 * Creates a deliberately short-lived plaintext editing workspace for a single
 * encrypted snapshot.  The host/editor boundary is intentionally narrow: only
 * a directory path crosses it; credentials and publication capabilities do not.
 */
export class ManualSnapshotViewManager {
  readonly snapshots: EncryptedSnapshotStore;

  constructor(snapshots: EncryptedSnapshotStore) {
    this.snapshots = snapshots;
  }

  async open(options: OpenManualSnapshotViewOptions): Promise<ManualSnapshotView> {
    assertSafeId(options.changeId);
    assertSafeId(options.snapshotId);
    assertSafeId(options.actorIdentityId);
    const requestedViewsDirectory = assertSafeViewsDirectory(options.viewsDirectory);
    const snapshot = await this.snapshots.readSnapshot(options.snapshotId);
    if (snapshot.changeId !== options.changeId) throw new Error("Snapshot does not belong to requested change");
    if (!await options.authorizeSnapshot(snapshot)) throw new Error("Snapshot is not authorized for manual editing");
    await assertSnapshotLineage(this.snapshots, snapshot, options.changeId);
    const manifest = await this.snapshots.readManifest(options.masterKey, snapshot);
    assertNoCredentialPaths(manifest.files.map((file) => file.path));
    const viewsDirectory = await prepareSafeViewsDirectory(requestedViewsDirectory);

    const runRoot = await createSafeRunRoot(viewsDirectory, newId("manual_view"));
    const directory = path.join(runRoot.path, "workspace");
    try {
      await mkdir(directory, { mode: 0o700 });
      await this.snapshots.materialize({
        masterKey: options.masterKey,
        snapshot,
        targetDirectory: directory,
        actorIdentityId: options.actorIdentityId,
      });
      return new ManualSnapshotView(this.snapshots, runRoot, directory, snapshot, options.masterKey, options.actorIdentityId, null, options.excludedPaths ?? []);
    } catch (error) {
      await safeRemoveRunPath(runRoot.path, runRoot, true).catch(() => undefined);
      throw error;
    }
  }

  /** Reattach after a command-scoped host exits, validating the guarded root. */
  async resume(options: ResumeManualSnapshotViewOptions): Promise<ManualSnapshotView> {
    assertSafeId(options.changeId);
    assertSafeId(options.snapshotId);
    assertSafeId(options.actorIdentityId);
    const viewsDirectory = await prepareSafeViewsDirectory(assertSafeViewsDirectory(options.viewsDirectory));
    const runRoot = await readSafeRunRoot(options.runRootPath, options.runRootToken);
    if (path.dirname(runRoot.path) !== viewsDirectory) throw new Error("Manual workspace is outside the managed views directory");
    const directory = path.join(runRoot.path, "workspace");
    if (path.resolve(options.directory) !== directory) throw new Error("Manual workspace directory does not match its guarded root");
    const workspace = await lstat(directory);
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) throw new Error("Manual workspace is no longer a safe directory");
    const snapshot = await this.snapshots.readSnapshot(options.snapshotId);
    if (snapshot.changeId !== options.changeId) throw new Error("Snapshot does not belong to requested change");
    if (!await options.authorizeSnapshot(snapshot)) throw new Error("Snapshot is not authorized for manual editing");
    await assertSnapshotLineage(this.snapshots, snapshot, options.changeId);
    await assertManualWorkspaceTree(directory);
    let latest: SnapshotRecord | null = null;
    if (options.latestSnapshotId) {
      latest = await this.snapshots.readSnapshot(options.latestSnapshotId);
      if (latest.changeId !== options.changeId) throw new Error("Manual checkpoint belongs to another change");
      await assertSnapshotLineage(this.snapshots, latest, options.changeId);
    }
    return new ManualSnapshotView(this.snapshots, runRoot, directory, snapshot, options.masterKey, options.actorIdentityId, latest, options.excludedPaths ?? []);
  }
}

export class ManualSnapshotView {
  readonly directory: string;
  readonly sourceSnapshot: SnapshotRecord;
  readonly launchDescriptors: readonly ManualLaunchDescriptor[];
  readonly #snapshots: EncryptedSnapshotStore;
  readonly #runRoot: SafeRunRoot;
  readonly #masterKey: Buffer;
  readonly #actorIdentityId: string;
  readonly #excludedPaths: string[];
  #destroyed = false;
  #destroyPromise: Promise<void> | null = null;
  #watcher: FSWatcher | null = null;
  #debounceTimer: NodeJS.Timeout | null = null;
  #watchSession = 0;
  #autosnapshotOptions: StartManualAutosnapshotsOptions | null = null;
  #latestAutosnapshot: SnapshotRecord | null = null;
  #lastCapturedTreeHash: string;
  #autosnapshotStatus: Omit<ManualAutosnapshotStatus, "latestSnapshot"> = {
    active: false,
    pending: false,
    capturing: false,
    state: "stopped",
    lastError: null,
  };
  #captureTail: Promise<void> = Promise.resolve();

  constructor(snapshots: EncryptedSnapshotStore, runRoot: SafeRunRoot, directory: string, sourceSnapshot: SnapshotRecord, masterKey: Buffer, actorIdentityId: string, latestAutosnapshot: SnapshotRecord | null = null, excludedPaths: string[] = []) {
    this.#snapshots = snapshots;
    this.#runRoot = runRoot;
    this.directory = directory;
    this.sourceSnapshot = sourceSnapshot;
    this.#masterKey = Buffer.from(masterKey);
    this.#actorIdentityId = actorIdentityId;
    this.#excludedPaths = [...excludedPaths];
    this.#latestAutosnapshot = latestAutosnapshot;
    this.#lastCapturedTreeHash = latestAutosnapshot?.treeHash ?? sourceSnapshot.treeHash;
    this.launchDescriptors = ["vscode", "cursor", "terminal", "copy-path"].map((kind) => ({ kind, directory })) as ManualLaunchDescriptor[];
  }

  get latestAutosnapshot(): SnapshotRecord | null {
    return this.#latestAutosnapshot;
  }

  /** A polling-friendly status view; autosnapshotting is disabled until started. */
  get autosnapshotStatus(): ManualAutosnapshotStatus {
    return { ...this.#autosnapshotStatus, latestSnapshot: this.#latestAutosnapshot };
  }

  /**
   * Starts opt-in, debounced capture of this live plaintext workspace. Filesystem
   * notifications are only hints: every capture revalidates the full tree.
   */
  startAutosnapshots(options: StartManualAutosnapshotsOptions): ManualAutosnapshotStatus {
    this.#assertLive();
    const debounceMs = options.debounceMs ?? 2_000;
    if (!Number.isFinite(debounceMs) || debounceMs < 0) throw new Error("autosnapshot debounceMs must be a non-negative finite number");
    this.stopAutosnapshots();
    const session = ++this.#watchSession;
    this.#autosnapshotOptions = { ...options, debounceMs };
    this.#autosnapshotStatus = {
      active: true,
      pending: false,
      capturing: false,
      state: "waiting",
      lastError: null,
    };
    try {
      this.#watcher = watch(this.directory, { recursive: true }, () => this.#scheduleAutosnapshot(session));
      this.#watcher.on("error", (error) => this.#failAutosnapshots(error));
      // Some watcher backends can coalesce or miss a write made immediately
      // after registration. This deduplicated scan ensures that edit is seen.
      this.#scheduleAutosnapshot(session);
    } catch (error) {
      this.#failAutosnapshots(error);
      throw error;
    }
    return this.autosnapshotStatus;
  }

  /** Stops observing new changes. A capture already in progress is allowed to finish safely. */
  stopAutosnapshots(): void {
    this.#watchSession += 1;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = null;
    this.#watcher?.close();
    this.#watcher = null;
    this.#autosnapshotOptions = null;
    this.#autosnapshotStatus = {
      ...this.#autosnapshotStatus,
      active: false,
      pending: false,
      state: this.#autosnapshotStatus.capturing ? "capturing" : "stopped",
    };
  }

  /** Captures edits as a new immutable child, optionally continuing the autosnapshot chain. */
  async capture(options: CaptureManualSnapshotOptions): Promise<SnapshotRecord> {
    this.#assertLive();
    if (!Number.isSafeInteger(options.eventSequence) || options.eventSequence < 0) throw new Error("eventSequence must be non-negative");
    return this.#enqueueCapture(async () => {
      this.#assertLive();
      const snapshot = await this.#captureManual({
        eventSequence: options.eventSequence,
        ...(options.evidenceObjectIds ? { evidenceObjectIds: options.evidenceObjectIds } : {}),
        ...(options.now ? { now: options.now } : {}),
        parentSnapshotId: options.parent === "latest-autosnapshot" ? (this.#latestAutosnapshot?.id ?? this.sourceSnapshot.id) : this.sourceSnapshot.id,
      });
      if (!snapshot) throw new Error("Manual capture unexpectedly produced no snapshot");
      this.#lastCapturedTreeHash = snapshot.treeHash;
      return snapshot;
    });
  }

  /**
   * Revalidates the live plaintext tree without creating an encrypted snapshot.
   * Callers can use this before committing an external lifecycle transition.
   * Capture repeats the same validation before reading workspace contents.
   */
  async validateWorkspace(): Promise<void> {
    this.#assertLive();
    await this.#enqueueCapture(async () => {
      this.#assertLive();
      const metadata = await lstat(this.directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Manual workspace is no longer a safe directory");
      await assertManualWorkspaceTree(this.directory);
      this.#assertLive();
    });
  }

  /** Removes the plaintext workspace and its guard marker. Safe to call twice. */
  async destroy(): Promise<void> {
    if (this.#destroyPromise) return this.#destroyPromise;
    this.#destroyed = true;
    this.stopAutosnapshots();
    this.#destroyPromise = (async () => {
      try {
        await this.#captureTail;
        await safeRemoveRunPath(this.#runRoot.path, this.#runRoot, true);
      } finally {
        this.#masterKey.fill(0);
      }
    })();
    return this.#destroyPromise;
  }

  #scheduleAutosnapshot(session: number): void {
    if (this.#destroyed || session !== this.#watchSession || !this.#autosnapshotStatus.active || !this.#autosnapshotOptions) return;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#autosnapshotStatus = { ...this.#autosnapshotStatus, pending: true, state: "waiting" };
    const debounceMs = this.#autosnapshotOptions.debounceMs;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this.#autosnapshotStatus = { ...this.#autosnapshotStatus, pending: false };
      this.#enqueueAutosnapshot(session);
    }, debounceMs);
  }

  #enqueueAutosnapshot(session: number): void {
    void this.#enqueueCapture(async () => {
      if (this.#destroyed || session !== this.#watchSession || !this.#autosnapshotStatus.active || !this.#autosnapshotOptions) return;
      this.#autosnapshotStatus = { ...this.#autosnapshotStatus, capturing: true, state: "capturing", lastError: null };
      try {
        const options = this.#autosnapshotOptions;
        const eventSequence = typeof options.eventSequence === "function" ? await options.eventSequence() : options.eventSequence;
        if (!Number.isSafeInteger(eventSequence) || eventSequence < 0) throw new Error("autosnapshot eventSequence must be non-negative");
        if (this.#destroyed || session !== this.#watchSession || !this.#autosnapshotStatus.active) return;
        this.#assertLive();
        const snapshot = await this.#captureManual({
          eventSequence,
          ...(options.evidenceObjectIds ? { evidenceObjectIds: options.evidenceObjectIds } : {}),
          ...(options.now ? { now: options.now() } : {}),
          parentSnapshotId: this.#latestAutosnapshot?.id ?? this.sourceSnapshot.id,
          previousTreeHash: this.#lastCapturedTreeHash,
        });
        if (snapshot) {
          this.#latestAutosnapshot = snapshot;
          this.#lastCapturedTreeHash = snapshot.treeHash;
          await options.onCaptured?.(snapshot);
        }
      } catch (error) {
        this.#autosnapshotStatus = { ...this.#autosnapshotStatus, lastError: error instanceof Error ? error.message : String(error), state: "error" };
      } finally {
        this.#autosnapshotStatus = {
          ...this.#autosnapshotStatus,
          capturing: false,
          state: this.#autosnapshotStatus.active ? (this.#autosnapshotStatus.lastError ? "error" : "waiting") : "stopped",
        };
      }
    });
  }

  #enqueueCapture<T>(capture: () => Promise<T>): Promise<T> {
    const result = this.#captureTail.then(capture, capture);
    this.#captureTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #captureManual(options: {
    eventSequence: number;
    evidenceObjectIds?: string[];
    now?: Date;
    parentSnapshotId: string;
    previousTreeHash?: string;
  }): Promise<SnapshotRecord | null> {
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Manual workspace is no longer a safe directory");
    await assertManualWorkspaceTree(this.directory);
    this.#assertLive();
    const captureOptions = {
      masterKey: this.#masterKey,
      changeId: this.sourceSnapshot.changeId,
      sourceDirectory: this.directory,
      parentSnapshotId: options.parentSnapshotId,
      actorIdentityId: this.#actorIdentityId,
      reason: "manual" as const,
      eventSequence: options.eventSequence,
      assertSafePath: assertManualWorkspacePath,
      excludePaths: this.#excludedPaths,
      ...(options.evidenceObjectIds ? { evidenceObjectIds: options.evidenceObjectIds } : {}),
      ...(options.now ? { now: options.now } : {}),
    };
    if (options.previousTreeHash !== undefined) return this.#snapshots.captureIfTreeChanged(captureOptions, options.previousTreeHash);
    return this.#snapshots.capture(captureOptions);
  }

  #failAutosnapshots(error: unknown): void {
    this.#watchSession += 1;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = null;
    this.#watcher?.close();
    this.#watcher = null;
    this.#autosnapshotOptions = null;
    this.#autosnapshotStatus = {
      ...this.#autosnapshotStatus,
      active: false,
      pending: false,
      state: "error",
      lastError: error instanceof Error ? error.message : String(error),
    };
  }

  #assertLive(): void {
    if (this.#destroyed) throw new Error("Manual snapshot view has been destroyed");
  }
}

function assertSafeViewsDirectory(value: string): string {
  if (value.includes("\0")) throw new Error("Manual views directory contains a NUL byte");
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error("Manual views directory cannot be a filesystem root");
  return resolved;
}

async function prepareSafeViewsDirectory(resolved: string): Promise<string> {
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const status = await lstat(resolved);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("Manual views directory must be a real directory");
  const canonical = await realpath(resolved);
  if (canonical === path.parse(canonical).root) throw new Error("Manual views directory cannot resolve to a filesystem root");
  return canonical;
}

function assertNoCredentialPaths(paths: string[]): void {
  for (const relativePath of paths) {
    if (FORBIDDEN_WORKSPACE_PATH.test(relativePath)) {
      throw new Error(`Snapshot contains a forbidden manual-workspace path: ${relativePath}`);
    }
  }
}

function assertManualWorkspacePath(relativePath: string): void {
  assertNoCredentialPaths([relativePath]);
}

async function assertManualWorkspaceTree(root: string): Promise<void> {
  const paths: string[] = [];
  const inspect = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const status = await lstat(absolute);
      if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) {
        throw new Error(`Manual workspace contains an unsafe file: ${relative}`);
      }
      paths.push(relative);
      if (status.isDirectory()) await inspect(absolute);
    }
  };
  await inspect(root);
  const contextPaths = paths.filter((relative) => relative === ".veil" || relative.startsWith(".veil/"));
  if (contextPaths.some((relative) => relative !== ".veil" && relative !== ".veil/config.json")) {
    throw new Error("Manual workspace contains an invalid .veil context marker");
  }
  assertNoCredentialPaths(paths.filter((relative) => !contextPaths.includes(relative)));
}

async function assertSnapshotLineage(store: EncryptedSnapshotStore, initial: SnapshotRecord, changeId: string): Promise<void> {
  const seen = new Set<string>();
  let current: SnapshotRecord | null = initial;
  while (current) {
    if (current.changeId !== changeId) throw new Error("Snapshot lineage crosses a change boundary");
    if (seen.has(current.id)) throw new Error("Snapshot lineage contains a cycle");
    seen.add(current.id);
    current = current.parentSnapshotId ? await store.readSnapshot(current.parentSnapshotId) : null;
  }
}
