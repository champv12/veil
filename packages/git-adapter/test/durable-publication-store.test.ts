import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AuthenticatedFileDurablePublicationStore,
  type DurablePublicationRecord,
} from "../src/index.js";

const record: DurablePublicationRecord = {
  id: "publication_store_test",
  changeId: "change_store_test",
  basis: {
    id: `sha256:${"1".repeat(64)}`,
    workspaceTreeId: `sha256:${"2".repeat(64)}`,
    repositoryAnchorId: `sha256:${"3".repeat(64)}`,
    reviewId: `sha256:${"4".repeat(64)}`,
    checkReceiptIds: ["check_store_test"],
  },
  repositoryUrl: "https://github.com/acme/app",
  baseBranch: "main",
  branch: "veil/store-test",
  commit: "5".repeat(40),
  title: "Store publication attempt",
  marker: `veil-publication:publication_store_test:sha256:${"1".repeat(64)}`,
  createDraftPullRequest: true,
  state: "approved",
  completedSteps: [],
  stepJournal: [],
  createdAt: "2026-08-09T12:00:00.000Z",
  updatedAt: "2026-08-09T12:00:00.000Z",
};

test("authenticated publication records survive restart and reject tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-publication-store-"));
  const key = randomBytes(32);
  try {
    const first = new AuthenticatedFileDurablePublicationStore(root, key);
    await first.save(record);
    const restarted = new AuthenticatedFileDurablePublicationStore(root, key);
    assert.deepEqual(await restarted.load(record.id), record);

    const target = path.join(root, "records", `${record.id}.json`);
    const envelope = JSON.parse(await readFile(target, "utf8")) as { record: DurablePublicationRecord; mac: string };
    envelope.record.branch = "veil/tampered";
    await writeFile(target, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await assert.rejects(restarted.load(record.id), /authentication failed/i);
  } finally {
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("independent publication stores serialize one ID across instances", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-publication-lock-"));
  const key = randomBytes(32);
  try {
    const first = new AuthenticatedFileDurablePublicationStore(root, key);
    const second = new AuthenticatedFileDurablePublicationStore(root, key);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });

    const firstOperation = first.withLock(record.id, async () => {
      order.push("first-enter");
      firstEntered();
      await held;
      order.push("first-exit");
    });
    await entered;
    const secondOperation = second.withLock(record.id, async () => { order.push("second-enter"); });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(order, ["first-enter"]);
    releaseFirst();
    await Promise.all([firstOperation, secondOperation]);
    assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
  } finally {
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("a displaced live owner still excludes contenders until its operation releases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-publication-lock-takeover-"));
  const key = randomBytes(32);
  try {
    const first = new AuthenticatedFileDurablePublicationStore(root, key);
    const second = new AuthenticatedFileDurablePublicationStore(root, key);
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const firstOperation = first.withLock(record.id, async () => { firstEntered(); await held; });
    await entered;

    const lockDirectory = path.join(root, "locks", `${record.id}.lock`);
    const displaced = `${lockDirectory}.stale-adversarial`;
    await rename(lockDirectory, displaced);
    let secondEntered = false;
    const secondOperation = second.withLock(record.id, async () => { secondEntered = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const excludedWhileFirstRan = !secondEntered;
    releaseFirst();
    await Promise.all([firstOperation, secondOperation]);

    assert.equal(excludedWhileFirstRan, true);
    assert.equal(secondEntered, true);
    await assert.rejects(access(displaced), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent malformed stale-lock reclamation never deletes a successor owner", async () => {
  let maximumConcurrentOwners = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const root = await mkdtemp(path.join(os.tmpdir(), "veil-publication-malformed-lock-race-"));
    const key = randomBytes(32);
    try {
      const lockDirectory = path.join(root, "locks", `${record.id}.lock`);
      await mkdir(lockDirectory, { recursive: true });
      const ownerPath = path.join(lockDirectory, "owner.json");
      // Keep many reclaimers inside the same stale-owner read long enough for
      // one to install a successor before another reaches quarantine.
      await writeFile(ownerPath, `{${" ".repeat(1024 * 1024)}`);
      await utimes(ownerPath, new Date(0), new Date(0));
      await utimes(lockDirectory, new Date(0), new Date(0));

      let concurrentOwners = 0;
      let peak = 0;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const operations = Array.from({ length: 32 }, () => new AuthenticatedFileDurablePublicationStore(root, key)
        .withLock(record.id, async () => {
          concurrentOwners += 1;
          peak = Math.max(peak, concurrentOwners);
          await held;
          concurrentOwners -= 1;
        }));
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      maximumConcurrentOwners = Math.max(maximumConcurrentOwners, peak);
      release();
      await Promise.all(operations);
      maximumConcurrentOwners = Math.max(maximumConcurrentOwners, peak);
    } finally {
      key.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  }
  assert.equal(maximumConcurrentOwners, 1);
});
