import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DurablePublicationRecord, DurablePublicationStore } from "./publication-coordinator.js";

const LOCK_WAIT_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 25;
const OWNER_CREATION_GRACE_MS = 5_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

interface AuthenticatedPublicationRecord {
  version: 1;
  record: DurablePublicationRecord;
  mac: string;
}

/**
 * Authenticated, atomic local persistence for publication attempts. A
 * filesystem lock serializes the same attempt across Runner processes; the
 * HMAC prevents an unauthenticated local file edit from authorizing a remote
 * publication effect.
 */
export class AuthenticatedFileDurablePublicationStore implements DurablePublicationStore {
  readonly root: string;
  readonly recordsDirectory: string;
  readonly locksDirectory: string;
  readonly #authenticationKey: Buffer;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(root: string, authenticationKey: Buffer) {
    if (authenticationKey.length !== 32) throw new Error("Publication store authentication key must be 32 bytes");
    this.root = path.resolve(root);
    this.recordsDirectory = path.join(this.root, "records");
    this.locksDirectory = path.join(this.root, "locks");
    this.#authenticationKey = authenticationKey;
  }

  async load(id: string): Promise<DurablePublicationRecord | undefined> {
    assertSafeId(id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#recordPath(id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!isAuthenticatedRecord(parsed) || parsed.record.id !== id) {
      throw new Error("Durable publication record is invalid");
    }
    const expected = Buffer.from(authenticationMac(this.#authenticationKey, parsed.record), "hex");
    const actual = Buffer.from(parsed.mac, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("Durable publication record authentication failed");
    }
    return structuredClone(parsed.record);
  }

  async save(record: DurablePublicationRecord): Promise<void> {
    assertSafeId(record.id);
    await mkdir(this.recordsDirectory, { recursive: true, mode: 0o700 });
    const target = this.#recordPath(record.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}`;
    const envelope: AuthenticatedPublicationRecord = {
      version: 1,
      record: structuredClone(record),
      mac: authenticationMac(this.#authenticationKey, record),
    };
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  }

  async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    assertSafeId(id);
    const prior = this.#locks.get(id) ?? Promise.resolve();
    let releaseQueue = (): void => undefined;
    const gate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const queued = prior.then(() => gate);
    this.#locks.set(id, queued);
    await prior;
    let releaseFilesystemLock: (() => Promise<void>) | undefined;
    try {
      releaseFilesystemLock = await this.#acquireFilesystemLock(id);
      return await operation();
    } finally {
      await releaseFilesystemLock?.();
      releaseQueue();
      if (this.#locks.get(id) === queued) this.#locks.delete(id);
    }
  }

  #recordPath(id: string): string {
    return path.join(this.recordsDirectory, `${id}.json`);
  }

  async #acquireFilesystemLock(id: string): Promise<() => Promise<void>> {
    await mkdir(this.locksDirectory, { recursive: true, mode: 0o700 });
    const lockDirectory = path.join(this.locksDirectory, `${id}.lock`);
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    for (;;) {
      if (await this.#hasLiveDisplacedClaim(id)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for publication lock: ${id}`);
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        continue;
      }
      const token = randomUUID();
      const claimDirectory = `${lockDirectory}.claim-${process.pid}-${token}`;
      try {
        await mkdir(claimDirectory, { mode: 0o700 });
        await writeFile(path.join(claimDirectory, "owner.json"), `${JSON.stringify({ version: 1, token, pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
        await rename(claimDirectory, lockDirectory);
      } catch (error) {
        await rm(claimDirectory, { recursive: true, force: true }).catch(() => undefined);
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        const stale = await staleLockOwner(path.join(lockDirectory, "owner.json"), lockDirectory);
        if (stale.stale) {
          const quarantine = `${lockDirectory}.stale-${process.pid}-${randomUUID()}`;
          try {
            await rename(lockDirectory, quarantine);
          } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw renameError;
          }
          const quarantinedToken = await readLockToken(path.join(quarantine, "owner.json"));
          if (stale.token !== null && quarantinedToken === stale.token) {
            await rm(quarantine, { recursive: true, force: true });
          }
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for publication lock: ${id}`);
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        continue;
      }

      if (await this.#hasLiveDisplacedClaim(id)) {
        await this.#releaseTokenClaims(id, token);
        continue;
      }
      return async () => this.#releaseTokenClaims(id, token);
    }
  }

  async #hasLiveDisplacedClaim(id: string): Promise<boolean> {
    let live = false;
    for (const directory of await this.#displacedClaims(id)) {
      const ownerPath = path.join(directory, "owner.json");
      const stale = await staleLockOwner(ownerPath, directory);
      if (stale.stale) await rm(directory, { recursive: true, force: true });
      else live = true;
    }
    return live;
  }

  async #releaseTokenClaims(id: string, token: string): Promise<void> {
    const lockDirectory = path.join(this.locksDirectory, `${id}.lock`);
    const displaced = `${lockDirectory}.release-${process.pid}-${randomUUID()}`;
    try {
      await rename(lockDirectory, displaced);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const directory of [displaced, ...await this.#displacedClaims(id)]) {
      if (await readLockToken(path.join(directory, "owner.json")) === token) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }

  async #displacedClaims(id: string): Promise<string[]> {
    const prefix = `${id}.lock.`;
    let entries;
    try { entries = await readdir(this.locksDirectory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return entries
      .filter((entry) => entry.isDirectory()
        && entry.name.startsWith(prefix)
        && (entry.name.includes(".stale-") || entry.name.includes(".release-")))
      .map((entry) => path.join(this.locksDirectory, entry.name));
  }
}

function assertSafeId(value: string): void {
  if (!SAFE_ID.test(value)) throw new Error("Publication store identifier is invalid");
}

function authenticationMac(key: Buffer, record: DurablePublicationRecord): string {
  return createHmac("sha256", key)
    .update("veil-durable-publication-v1\0")
    .update(canonicalJson(record), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Publication record contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
  }
  throw new Error("Publication record contains a non-JSON value");
}

function isAuthenticatedRecord(value: unknown): value is AuthenticatedPublicationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AuthenticatedPublicationRecord>;
  return candidate.version === 1
    && candidate.record !== null
    && typeof candidate.record === "object"
    && typeof candidate.record.id === "string"
    && typeof candidate.mac === "string"
    && /^[0-9a-f]{64}$/.test(candidate.mac);
}

async function readLockToken(ownerPath: string): Promise<string | null> {
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
    return typeof owner.token === "string" ? owner.token : null;
  } catch {
    return null;
  }
}

async function staleLockOwner(ownerPath: string, lockDirectory: string): Promise<{ stale: boolean; token: string | null }> {
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
    try {
      const age = Date.now() - (await lstat(lockDirectory)).mtimeMs;
      return { stale: age >= OWNER_CREATION_GRACE_MS, token: null };
    } catch {
      return { stale: false, token: null };
    }
  }
}
