import { constants } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertSnapshotRecord,
  identifyWorkspaceTree,
  type SnapshotReason,
  type SnapshotRecord,
  type WorkspaceTreeIdentity,
} from "@veil/contracts";
import { decryptObject, encryptObject, type EncryptedObjectEnvelope } from "./crypto.js";
import type { JsonEventStore } from "./event-store.js";
import { assertSafeId, assertSafeRelativePath, canonicalJson, durableWriteFile, newId, resolveWithin, sha256 } from "./util.js";

/** `.veil` is a local context locator, never repository snapshot content. */
const EXCLUDED_COMPONENTS = new Set([".git", ".veil", ".veil-private", ".veil-state", ".veil-runs"]);

export interface SnapshotFile {
  path: string;
  mode: number;
  size: number;
  objectId: string;
  sha256: string;
}

export interface SnapshotManifest {
  version: 1;
  files: SnapshotFile[];
}

export function identifySnapshotWorkspaceTree(manifest: SnapshotManifest): WorkspaceTreeIdentity {
  return identifyWorkspaceTree({
    version: 1,
    hashAlgorithm: "sha256",
    entries: manifest.files.map((file) => ({
      path: file.path,
      kind: "file",
      executable: (file.mode & 0o111) !== 0,
      size: file.size,
      contentSha256: file.sha256,
    })),
  });
}

/** Provider-neutral ciphertext repository. Implementations never receive plaintext. */
export interface EncryptedObjectRepository {
  initialize?(): Promise<void>;
  put(envelope: EncryptedObjectEnvelope): Promise<void>;
  get(objectId: string): Promise<EncryptedObjectEnvelope>;
}

interface TreeFile {
  path: string;
  mode: number;
  data: Buffer;
}

export interface SnapshotCaptureOptions {
  masterKey: Buffer;
  changeId: string;
  sourceDirectory: string;
  parentSnapshotId: string | null;
  actorIdentityId: string;
  reason: SnapshotReason;
  eventSequence: number;
  evidenceObjectIds?: string[];
  now?: Date;
  /**
   * Optional caller-owned policy applied to every entry while the tree is
   * walked. It is useful for stricter contexts such as plaintext manual views.
   */
  assertSafePath?: (relativePath: string) => void;
  /** Base-pinned generated paths that must not enter durable snapshots. */
  excludePaths?: string[];
}

export class EncryptedSnapshotStore {
  readonly root: string;
  readonly objectsDirectory: string;
  readonly snapshotsDirectory: string;
  readonly #events: JsonEventStore | undefined;
  readonly #objectRepository: EncryptedObjectRepository | undefined;

  constructor(root: string, events?: JsonEventStore, objectRepository?: EncryptedObjectRepository) {
    this.root = path.resolve(root);
    this.objectsDirectory = path.join(this.root, "objects");
    this.snapshotsDirectory = path.join(this.root, "snapshots");
    this.#events = events;
    this.#objectRepository = objectRepository;
  }

  async initialize(): Promise<void> {
    const initializeObjects = this.#objectRepository
      ? (this.#objectRepository.initialize?.() ?? Promise.resolve())
      : mkdir(this.objectsDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      initializeObjects,
      mkdir(this.snapshotsDirectory, { recursive: true, mode: 0o700 }),
    ]);
  }

  async capture(options: SnapshotCaptureOptions): Promise<SnapshotRecord> {
    assertSafeId(options.changeId);
    assertSafeId(options.actorIdentityId);
    if (!Number.isSafeInteger(options.eventSequence) || options.eventSequence < 0) throw new Error("eventSequence must be non-negative");
    await this.initialize();
    await this.#assertParent(options);
    const tree = await readSafeTree(options.sourceDirectory, options.assertSafePath, normalizeExclusions(options.excludePaths));
    return this.#captureTree(options, tree);
  }

  /**
   * Captures only when the complete tree differs from the supplied hash. The
   * decision and capture use the same tree traversal, so callers do not create
   * a duplicate snapshot merely because they pre-computed a stale fingerprint.
   */
  async captureIfTreeChanged(options: SnapshotCaptureOptions, previousTreeHash: string | null): Promise<SnapshotRecord | null> {
    assertSafeId(options.changeId);
    assertSafeId(options.actorIdentityId);
    if (!Number.isSafeInteger(options.eventSequence) || options.eventSequence < 0) throw new Error("eventSequence must be non-negative");
    await this.initialize();
    await this.#assertParent(options);
    const tree = await readSafeTree(options.sourceDirectory, options.assertSafePath, normalizeExclusions(options.excludePaths));
    if (previousTreeHash !== null && treeHashForTree(tree) === previousTreeHash) return null;
    return this.#captureTree(options, tree);
  }

  async #captureTree(options: SnapshotCaptureOptions, tree: TreeFile[]): Promise<SnapshotRecord> {
    const manifestFiles: SnapshotFile[] = [];
    for (const file of tree) {
      const envelope = encryptObject(options.masterKey, options.changeId, "file", file.data);
      await this.#storeEnvelope(envelope);
      const digest = sha256(file.data);
      manifestFiles.push({ path: file.path, mode: file.mode, size: file.data.length, objectId: envelope.objectId, sha256: digest });
    }
    const manifest: SnapshotManifest = { version: 1, files: manifestFiles };
    const manifestEnvelope = encryptObject(options.masterKey, options.changeId, "manifest", Buffer.from(canonicalJson(manifest)));
    await this.#storeEnvelope(manifestEnvelope);
    const unsigned: Omit<SnapshotRecord, "headerMac"> = {
      id: newId("snapshot"),
      changeId: options.changeId,
      parentSnapshotId: options.parentSnapshotId,
      actorIdentityId: options.actorIdentityId,
      encryptedManifestObjectId: manifestEnvelope.objectId,
      evidenceObjectIds: options.evidenceObjectIds ?? [],
      reason: options.reason,
      eventSequence: options.eventSequence,
      treeHash: treeHashForTree(tree),
      createdAt: (options.now ?? new Date()).toISOString(),
    };
    const record: SnapshotRecord = {
      ...unsigned,
      headerMac: snapshotHeaderMac(options.masterKey, unsigned),
    };
    assertSnapshotRecord(record);
    await durableWriteFile(path.join(this.snapshotsDirectory, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    await this.#events?.appendAudit(options.changeId, "snapshot.captured", options.actorIdentityId, {
      snapshotId: record.id,
      parentSnapshotId: record.parentSnapshotId,
      reason: record.reason,
      eventSequence: record.eventSequence,
      treeHash: record.treeHash,
    }, options.now);
    return record;
  }

  async #assertParent(options: SnapshotCaptureOptions): Promise<void> {
    if (options.parentSnapshotId === null) return;
    const parent = await this.readSnapshot(options.parentSnapshotId, options.masterKey);
    if (parent.changeId !== options.changeId) throw new Error("Snapshot parent belongs to another change");
  }

  async captureAutomatic(options: Omit<SnapshotCaptureOptions, "reason"> & { final?: boolean }): Promise<SnapshotRecord> {
    const { final, ...captureOptions } = options;
    return this.capture({ ...captureOptions, reason: final ? "agent_final" : "agent_file_change" });
  }

  async readSnapshot(snapshotId: string, masterKey?: Buffer): Promise<SnapshotRecord> {
    assertSafeId(snapshotId);
    const value: unknown = JSON.parse(await readFile(path.join(this.snapshotsDirectory, `${snapshotId}.json`), "utf8"));
    assertSnapshotRecord(value);
    if (value.id !== snapshotId) throw new Error("Snapshot identifier does not match its durable address");
    if (masterKey) assertSnapshotHeaderAuthenticated(masterKey, value);
    return value;
  }

  async readManifest(masterKey: Buffer, snapshot: SnapshotRecord): Promise<SnapshotManifest> {
    assertSnapshotHeaderAuthenticated(masterKey, snapshot);
    const envelope = await this.#loadEnvelope(snapshot.encryptedManifestObjectId);
    if (envelope.changeId !== snapshot.changeId) throw new Error("Manifest belongs to another change");
    const value: unknown = JSON.parse(decryptObject(masterKey, envelope, "manifest").toString("utf8"));
    if (!isManifest(value)) throw new Error("Invalid snapshot manifest");
    assertManifestPaths(value);
    return value;
  }

  async materialize(options: {
    masterKey: Buffer;
    snapshot: SnapshotRecord;
    targetDirectory: string;
    actorIdentityId?: string;
  }): Promise<SnapshotManifest> {
    const target = path.resolve(options.targetDirectory);
    await mkdir(target, { recursive: true, mode: 0o700 });
    if ((await readdir(target)).length > 0) throw new Error(`Materialization target is not empty: ${target}`);
    const manifest = await this.readManifest(options.masterKey, options.snapshot);
    for (const file of manifest.files) {
      assertSafeRelativePath(file.path);
      const destination = resolveWithin(target, file.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const envelope = await this.#loadEnvelope(file.objectId);
      if (envelope.changeId !== options.snapshot.changeId) throw new Error(`File belongs to another change: ${file.path}`);
      const data = decryptObject(options.masterKey, envelope, "file");
      if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error(`File integrity mismatch: ${file.path}`);
      await writeFile(destination, data, { flag: "wx", mode: file.mode });
      await chmod(destination, file.mode);
    }
    const reconstructedHash = hashManifestTree(manifest);
    if (reconstructedHash !== options.snapshot.treeHash) throw new Error("Snapshot tree hash mismatch");
    await this.#events?.appendAudit(options.snapshot.changeId, "snapshot.materialized", options.actorIdentityId ?? null, {
      snapshotId: options.snapshot.id,
      treeHash: reconstructedHash,
    });
    return manifest;
  }

  async storeEvidence(masterKey: Buffer, changeId: string, evidence: Buffer): Promise<string> {
    const envelope = encryptObject(masterKey, changeId, "evidence", evidence);
    await this.#storeEnvelope(envelope);
    return envelope.objectId;
  }

  async decryptEvidence(masterKey: Buffer, objectId: string): Promise<Buffer> {
    return decryptObject(masterKey, await this.#loadEnvelope(objectId), "evidence");
  }

  async #storeEnvelope(envelope: EncryptedObjectEnvelope): Promise<void> {
    if (this.#objectRepository) {
      await this.#objectRepository.put(envelope);
      return;
    }
    const target = path.join(this.objectsDirectory, `${envelope.objectId}.json`);
    try {
      const existing: unknown = JSON.parse(await readFile(target, "utf8"));
      this.#assertMatchingEnvelope(existing, envelope);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await durableWriteFile(target, canonicalJson(envelope));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing: unknown = JSON.parse(await readFile(target, "utf8"));
      this.#assertMatchingEnvelope(existing, envelope);
    }
  }

  #assertMatchingEnvelope(existing: unknown, envelope: EncryptedObjectEnvelope): void {
    if (!isEncryptedObjectEnvelope(existing) || existing.objectId !== envelope.objectId || existing.objectType !== envelope.objectType || existing.changeId !== envelope.changeId) {
      throw new Error(`Encrypted object collision: ${envelope.objectId}`);
    }
  }

  async #loadEnvelope(objectId: string): Promise<EncryptedObjectEnvelope> {
    if (!/^[a-f0-9]{64}$/.test(objectId)) throw new Error("Invalid object identifier");
    if (this.#objectRepository) return this.#objectRepository.get(objectId);
    const value: unknown = JSON.parse(await readFile(path.join(this.objectsDirectory, `${objectId}.json`), "utf8"));
    if (!isEncryptedObjectEnvelope(value)) throw new Error(`Invalid encrypted envelope: ${objectId}`);
    if (value.objectId !== objectId) throw new Error(`Encrypted object address mismatch: ${objectId}`);
    return value;
  }
}

function snapshotHeaderMac(masterKey: Buffer, snapshot: Omit<SnapshotRecord, "headerMac">): string {
  if (masterKey.length !== 32) throw new Error("Workspace master key must be 256 bits");
  const key = createHmac("sha256", masterKey)
    .update("veil-snapshot-header-key-v1\0")
    .update(snapshot.changeId, "utf8")
    .digest();
  try {
    return createHmac("sha256", key)
      .update(canonicalJson(snapshot), "utf8")
      .digest("hex");
  } finally {
    key.fill(0);
  }
}

export function assertSnapshotHeaderAuthenticated(masterKey: Buffer, snapshot: SnapshotRecord): void {
  const { headerMac, ...unsigned } = snapshot;
  const expected = Buffer.from(snapshotHeaderMac(masterKey, unsigned), "hex");
  const actual = Buffer.from(headerMac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Snapshot header authentication failed");
  }
}

async function readSafeTree(sourceDirectory: string, assertSafePath?: (relativePath: string) => void, excludePaths = new Set<string>()): Promise<TreeFile[]> {
  const requested = path.resolve(sourceDirectory);
  const rootStatus = await lstat(requested);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) throw new Error("Snapshot source must be a real directory");
  const root = await realpath(requested);
  const files = await walkTree(root, "", assertSafePath, excludePaths);
  assertPortablePathSet(files.map((file) => file.path));
  return files;
}

async function walkTree(root: string, current = "", assertSafePath?: (relativePath: string) => void, excludePaths = new Set<string>()): Promise<TreeFile[]> {
  const directory = current ? resolveWithin(root, current) : root;
  const canonicalDirectory = await realpath(directory);
  if (canonicalDirectory !== root && !canonicalDirectory.startsWith(`${root}${path.sep}`)) throw new Error(`Directory escapes snapshot root: ${current}`);
  const files: TreeFile[] = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relativePath = current ? path.posix.join(current, entry.name) : entry.name;
    assertSafeRelativePath(relativePath);
    if (EXCLUDED_COMPONENTS.has(entry.name) || [...excludePaths].some((excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`))) continue;
    assertSafePath?.(relativePath);
    const absolutePath = resolveWithin(root, relativePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${relativePath}`);
    if (metadata.isDirectory()) files.push(...await walkTree(root, relativePath, assertSafePath, excludePaths));
    else if (metadata.isFile()) files.push({ path: relativePath, mode: metadata.mode & 0o777, data: await readSafeFile(absolutePath, relativePath) });
    else throw new Error(`Special files are not supported: ${relativePath}`);
  }
  return files;
}

async function readSafeFile(absolutePath: string, relativePath: string): Promise<Buffer> {
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`Special files are not supported: ${relativePath}`);
    if (before.nlink !== 1n) throw new Error(`Hard-linked files are not supported: ${relativePath}`);
    const data = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`File changed while it was being captured: ${relativePath}`);
    }
    return data;
  } finally { await handle.close(); }
}

function normalizeExclusions(input: string[] | undefined): Set<string> {
  const result = new Set<string>();
  for (const value of input ?? []) {
    assertSafeRelativePath(value);
    result.add(value);
  }
  return result;
}

function treeHashForTree(tree: TreeFile[]): string {
  const chunks = tree.map((file) => Buffer.from(`${file.path}\0${file.mode}\0${sha256(file.data)}\0`, "utf8"));
  return sha256(Buffer.concat(chunks));
}

export function isEncryptedObjectEnvelope(value: unknown): value is EncryptedObjectEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Partial<EncryptedObjectEnvelope>;
  return envelope.version === 1 && envelope.algorithm === "aes-256-gcm" &&
    typeof envelope.changeId === "string" && typeof envelope.objectId === "string" &&
    (envelope.objectType === "file" || envelope.objectType === "manifest" || envelope.objectType === "evidence") &&
    typeof envelope.nonce === "string" && typeof envelope.ciphertext === "string" && typeof envelope.authenticationTag === "string";
}

/** Reject malformed durable ciphertext before it reaches cryptographic code. */
export function assertEncryptedObjectEnvelope(value: unknown): asserts value is EncryptedObjectEnvelope {
  if (!isEncryptedObjectEnvelope(value)) throw new Error("Invalid encrypted object envelope");
}

function isManifest(value: unknown): value is SnapshotManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<SnapshotManifest>;
  return manifest.version === 1 && Array.isArray(manifest.files) && manifest.files.every((file) =>
    typeof file === "object" && file !== null &&
    typeof file.path === "string" && Number.isInteger(file.mode) && file.mode! >= 0 && file.mode! <= 0o777 &&
    Number.isSafeInteger(file.size) && file.size! >= 0 &&
    typeof file.objectId === "string" && /^[a-f0-9]{64}$/.test(file.objectId) &&
    typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256)
  );
}

function assertPortablePathSet(paths: string[]): void {
  const seen = new Map<string, string>();
  for (const relativePath of paths) {
    assertSafeRelativePath(relativePath);
    const portable = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
    const prior = seen.get(portable);
    if (prior !== undefined) throw new Error(`Snapshot paths collide across supported filesystems: ${prior} and ${relativePath}`);
    seen.set(portable, relativePath);
  }
}

function assertManifestPaths(manifest: SnapshotManifest): void {
  assertPortablePathSet(manifest.files.map((file) => file.path));
}

function hashManifestTree(manifest: SnapshotManifest): string {
  const chunks = manifest.files.map((file) => Buffer.from(`${file.path}\0${file.mode}\0${file.sha256}\0`, "utf8"));
  return sha256(Buffer.concat(chunks));
}
