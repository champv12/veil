import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  ChangeState,
  assertAuditEvent,
  assertPrivateChange,
  type AuditEvent,
  type AuditEventType,
  type BaseReference,
  type JsonValue,
  type PrivateChange,
} from "@veil/contracts";
import { assertLegalTransition } from "./state-machine.js";
import { assertSafeId, canonicalJson, durableWriteFile, newId } from "./util.js";

const LOCK_WAIT_TIMEOUT_MS = 30_000;
const INCOMPLETE_LOCK_STALE_MS = 10_000;

export interface CreatePrivateChangeInput {
  id?: string;
  title: string;
  description: string;
  base: BaseReference;
  ownerIdentityId: string;
  now?: Date;
}

export class JsonEventStore {
  readonly root: string;
  readonly changesDirectory: string;
  readonly eventsDirectory: string;
  readonly locksDirectory: string;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.changesDirectory = path.join(this.root, "changes");
    this.eventsDirectory = path.join(this.root, "events");
    this.locksDirectory = path.join(this.root, "locks");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.changesDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.eventsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.locksDirectory, { recursive: true, mode: 0o700 }),
    ]);
  }

  async createChange(input: CreatePrivateChangeInput): Promise<PrivateChange> {
    await this.initialize();
    const id = input.id ?? newId("change");
    assertSafeId(id);
    assertSafeId(input.ownerIdentityId);
    const timestamp = (input.now ?? new Date()).toISOString();
    const change: PrivateChange = {
      id,
      title: input.title,
      description: input.description,
      base: input.base,
      ownerIdentityId: input.ownerIdentityId,
      state: ChangeState.Preflight,
      rootSnapshotId: null,
      selectedCandidateId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    assertPrivateChange(change);
    await this.#withLock(id, async () => {
      await mkdir(this.#eventDirectory(id), { recursive: true, mode: 0o700 });
      await durableWriteFile(this.#changePath(id), `${JSON.stringify(change, null, 2)}\n`);
      await this.#appendAuditUnlocked(id, "change.created", input.ownerIdentityId, {
        state: change.state,
        baseCommit: change.base.baseCommit,
      });
    });
    return change;
  }

  async getChange(changeId: string): Promise<PrivateChange> {
    assertSafeId(changeId);
    const value: unknown = JSON.parse(await readFile(this.#changePath(changeId), "utf8"));
    assertPrivateChange(value);
    return value;
  }

  async listChanges(): Promise<PrivateChange[]> {
    await this.initialize();
    const names = (await readdir(this.changesDirectory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map((name) => this.getChange(name.slice(0, -5))));
  }

  async transition(
    changeId: string,
    to: ChangeState,
    actorIdentityId: string | null,
    details: JsonValue = {},
    now = new Date(),
  ): Promise<PrivateChange> {
    return this.#withLock(changeId, async () => {
      const current = await this.getChange(changeId);
      assertLegalTransition(current.state, to);
      const updated: PrivateChange = { ...current, state: to, updatedAt: now.toISOString() };
      await this.#writeChangeAtomic(updated);
      await this.#appendAuditUnlocked(changeId, "change.transitioned", actorIdentityId, {
        from: current.state,
        to,
        context: details,
      }, now);
      return updated;
    });
  }

  async updateChange(
    changeId: string,
    mutate: (change: PrivateChange) => PrivateChange,
  ): Promise<PrivateChange> {
    return this.#withLock(changeId, async () => {
      const updated = mutate(await this.getChange(changeId));
      if (updated.id !== changeId) throw new Error("A change update cannot replace its identifier");
      assertPrivateChange(updated);
      await this.#writeChangeAtomic(updated);
      return updated;
    });
  }

  async appendAudit(
    changeId: string,
    type: AuditEventType,
    actorIdentityId: string | null,
    details: JsonValue,
    now = new Date(),
  ): Promise<AuditEvent> {
    return this.#withLock(changeId, () => this.#appendAuditUnlocked(changeId, type, actorIdentityId, details, now));
  }

  async readAudit(changeId: string): Promise<AuditEvent[]> {
    assertSafeId(changeId);
    const directory = this.#eventDirectory(changeId);
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: AuditEvent[] = [];
    for (const name of names) {
      const value: unknown = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      assertAuditEvent(value);
      events.push(value);
    }
    return events;
  }

  async verifyAuditChain(changeId: string): Promise<boolean> {
    const events = await this.readAudit(changeId);
    let previousHash: string | null = null;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event || event.sequence !== index + 1 || event.previousHash !== previousHash) return false;
      const { hash, ...unsigned } = event;
      const expected = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
      if (hash !== expected) return false;
      previousHash = hash;
    }
    return true;
  }

  async #appendAuditUnlocked(
    changeId: string,
    type: AuditEventType,
    actorIdentityId: string | null,
    details: JsonValue,
    now = new Date(),
  ): Promise<AuditEvent> {
    assertSafeId(changeId);
    if (actorIdentityId !== null) assertSafeId(actorIdentityId);
    await mkdir(this.#eventDirectory(changeId), { recursive: true, mode: 0o700 });
    const prior = await this.readAudit(changeId);
    const previous = prior.at(-1) ?? null;
    const unsigned = {
      id: newId("event"),
      changeId,
      sequence: prior.length + 1,
      type,
      actorIdentityId,
      occurredAt: now.toISOString(),
      details,
      previousHash: previous?.hash ?? null,
    };
    const event: AuditEvent = {
      ...unsigned,
      hash: createHash("sha256").update(canonicalJson(unsigned)).digest("hex"),
    };
    assertAuditEvent(event);
    const filename = `${String(event.sequence).padStart(12, "0")}-${event.id}.json`;
    await durableWriteFile(path.join(this.#eventDirectory(changeId), filename), `${JSON.stringify(event, null, 2)}\n`);
    return event;
  }

  async #writeChangeAtomic(change: PrivateChange): Promise<void> {
    const target = this.#changePath(change.id);
    await durableWriteFile(target, `${JSON.stringify(change, null, 2)}\n`, { replace: true });
  }

  #changePath(changeId: string): string {
    assertSafeId(changeId);
    return path.join(this.changesDirectory, `${changeId}.json`);
  }

  #eventDirectory(changeId: string): string {
    assertSafeId(changeId);
    return path.join(this.eventsDirectory, changeId);
  }

  async #withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    assertSafeId(key);
    const prior = this.#locks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    this.#locks.set(key, queued);
    await prior;
    let releaseFilesystemLock: (() => Promise<void>) | null = null;
    try {
      releaseFilesystemLock = await this.#acquireFilesystemLock(key);
      return await operation();
    } finally {
      await releaseFilesystemLock?.();
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }

  async #acquireFilesystemLock(key: string): Promise<() => Promise<void>> {
    await mkdir(this.locksDirectory, { recursive: true, mode: 0o700 });
    const lockDirectory = path.join(this.locksDirectory, `${key}.lock`);
    const ownerPath = path.join(lockDirectory, "owner.json");
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    for (;;) {
      const token = randomUUID();
      let created = false;
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        created = true;
        await durableWriteFile(ownerPath, `${JSON.stringify({ version: 1, token, pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() })}\n`);
        return async () => {
          if (await this.#readLockToken(ownerPath) === token) await rm(lockDirectory, { recursive: true, force: true });
        };
      } catch (error) {
        if (created) await rm(lockDirectory, { recursive: true, force: true }).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      const staleOwner = await this.#staleLockOwner(ownerPath, lockDirectory);
      if (staleOwner.stale) {
        const quarantine = `${lockDirectory}.stale-${process.pid}-${randomUUID()}`;
        try {
          await rename(lockDirectory, quarantine);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const quarantinedToken = await this.#readLockToken(path.join(quarantine, "owner.json"));
        if (quarantinedToken !== staleOwner.token) {
          // The lock changed after it was inspected. Restore it instead of
          // deleting a new owner's claim.
          try { await rename(quarantine, lockDirectory); } catch { /* another owner won; never delete either path */ }
        } else {
          await rm(quarantine, { recursive: true, force: true });
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for change lock: ${key}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  async #staleLockOwner(ownerPath: string, lockDirectory: string): Promise<{ stale: boolean; token: string | null }> {
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown; pid?: unknown; hostname?: unknown };
      const token = typeof owner.token === "string" ? owner.token : null;
      if (!token || owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return { stale: false, token };
      try {
        process.kill(owner.pid as number, 0);
        return { stale: false, token };
      } catch (error) {
        return { stale: (error as NodeJS.ErrnoException).code === "ESRCH", token };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) return { stale: false, token: null };
      try { return { stale: Date.now() - (await stat(lockDirectory)).mtimeMs >= INCOMPLETE_LOCK_STALE_MS, token: null }; }
      catch { return { stale: false, token: null }; }
    }
  }

  async #readLockToken(ownerPath: string): Promise<string | null> {
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
      return typeof owner.token === "string" ? owner.token : null;
    } catch { return null; }
  }
}
