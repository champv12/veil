import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeId } from "./util.js";

export type ManualWorkspaceState = "open" | "checkpointing" | "capturing" | "abandoned";

/**
 * Only local routing/cleanup metadata. Repository files, prompts, and keys
 * stay in encrypted snapshots or Codex respectively.
 */
export interface DurableManualWorkspaceRecord {
  version: 1;
  id: string;
  apiChangeId: string;
  changeId: string;
  sourceSnapshotId: string;
  latestSnapshotId?: string;
  directory: string;
  runRootPath: string;
  runRootToken: string;
  nextEventSequence: number;
  state: ManualWorkspaceState;
  createdAt: string;
  updatedAt: string;
}

interface Envelope {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}

/** An encrypted durable registry so command-scoped hosts can resume a view. */
export class DurableManualWorkspaceRegistry {
  readonly root: string;
  readonly recordsDirectory: string;
  readonly keyPath: string;
  #key: Buffer | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.recordsDirectory = path.join(this.root, "records");
    this.keyPath = path.join(this.root, "private", "manual-workspaces.key");
  }

  async initialize(): Promise<void> {
    if (this.#key) return;
    await Promise.all([
      mkdir(path.join(this.root, "private"), { recursive: true, mode: 0o700 }),
      mkdir(this.recordsDirectory, { recursive: true, mode: 0o700 }),
    ]);
    try {
      this.#key = await readFile(this.keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(32);
      try {
        await writeFile(this.keyPath, key, { flag: "wx", mode: 0o600 });
        this.#key = key;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        this.#key = await readFile(this.keyPath);
      }
    }
    if (this.#key.length !== 32) throw new Error("Invalid manual workspace registry key");
    await chmod(this.keyPath, 0o600);
  }

  async save(record: DurableManualWorkspaceRecord): Promise<void> {
    assertRecord(record);
    await this.initialize();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key!, nonce);
    cipher.setAAD(Buffer.from(`manual-workspace:${record.id}`, "utf8"));
    const plaintext = Buffer.from(JSON.stringify(record), "utf8");
    const envelope: Envelope = {
      version: 1,
      algorithm: "aes-256-gcm",
      nonce: nonce.toString("base64"),
      ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64"),
      authenticationTag: cipher.getAuthTag().toString("base64"),
    };
    const target = this.#path(record.id);
    const temporary = `${target}.${randomBytes(8).toString("hex")}`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  }

  async get(id: string): Promise<DurableManualWorkspaceRecord | undefined> {
    assertSafeId(id);
    await this.initialize();
    try { return await this.#read(id); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<DurableManualWorkspaceRecord[]> {
    await this.initialize();
    const names = (await readdir(this.recordsDirectory))
      .filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(name))
      .sort();
    return Promise.all(names.map((name) => this.#read(name.slice(0, -5))));
  }

  async remove(id: string): Promise<void> {
    assertSafeId(id);
    await this.initialize();
    await rm(this.#path(id), { force: true });
  }

  close(): void {
    this.#key?.fill(0);
    this.#key = null;
  }

  async #read(id: string): Promise<DurableManualWorkspaceRecord> {
    assertSafeId(id);
    const envelope = JSON.parse(await readFile(this.#path(id), "utf8")) as Envelope;
    if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("Invalid manual workspace record");
    const decipher = createDecipheriv("aes-256-gcm", this.#key!, Buffer.from(envelope.nonce, "base64"));
    decipher.setAAD(Buffer.from(`manual-workspace:${id}`, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64"));
    const record = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8")) as unknown;
    assertRecord(record);
    if (record.id !== id) throw new Error("Invalid manual workspace record");
    return record;
  }

  #path(id: string): string {
    assertSafeId(id);
    return path.join(this.recordsDirectory, `${id}.json`);
  }
}

function assertRecord(value: unknown): asserts value is DurableManualWorkspaceRecord {
  if (typeof value !== "object" || value === null) throw new Error("Invalid manual workspace record");
  const record = value as Partial<DurableManualWorkspaceRecord>;
  if (record.version !== 1 || !["open", "checkpointing", "capturing", "abandoned"].includes(String(record.state))
    || typeof record.directory !== "string" || typeof record.runRootPath !== "string" || typeof record.runRootToken !== "string"
    || !Number.isSafeInteger(record.nextEventSequence) || (record.nextEventSequence ?? -1) < 0
    || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
    throw new Error("Invalid manual workspace record");
  }
  for (const id of [record.id, record.apiChangeId, record.changeId, record.sourceSnapshotId]) {
    if (typeof id !== "string") throw new Error("Invalid manual workspace record");
    assertSafeId(id);
  }
  if (record.latestSnapshotId !== undefined) {
    if (typeof record.latestSnapshotId !== "string") throw new Error("Invalid manual workspace record");
    assertSafeId(record.latestSnapshotId);
  }
}
