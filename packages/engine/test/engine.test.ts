import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ChangeState, type BaseReference } from "@veil/contracts";
import {
  EncryptedSnapshotStore,
  IdentityStore,
  JsonEventStore,
  ManualSnapshotViewManager,
  createAgentGrant,
  createSafeRunRoot,
  createWorkspaceMasterKey,
  decryptObject,
  DurableManualWorkspaceRegistry,
  encryptObject,
  safeRemoveRunPath,
  unwrapGrant,
} from "../src/index.js";

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for filesystem watcher");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const base: BaseReference = {
  repositoryUrl: "https://github.com/example/repo",
  owner: "example",
  repository: "repo",
  defaultBranch: "main",
  baseCommit: "a".repeat(40),
  importedAt: "2026-07-18T00:00:00.000Z",
};

test("event store enforces transitions and maintains a hash chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-events-"));
  try {
    const store = new JsonEventStore(path.join(root, "metadata"));
    const change = await store.createChange({ id: "change_test", title: "Fix", description: "Private fix", base, ownerIdentityId: "maintainer" });
    await assert.rejects(() => store.transition(change.id, ChangeState.PrivateReady, "maintainer"), /Illegal/);
    await store.transition(change.id, ChangeState.Importing, "maintainer");
    await store.transition(change.id, ChangeState.Encrypting, "maintainer");
    await store.transition(change.id, ChangeState.PrivateReady, "maintainer");
    await store.transition(change.id, ChangeState.Capturing, "maintainer", { source: "manual-capture" });
    await store.transition(change.id, ChangeState.Destroying, "maintainer");
    await store.transition(change.id, ChangeState.Evaluating, "maintainer");
    await store.transition(change.id, ChangeState.ReviewReady, "maintainer");
    assert.equal((await store.getChange(change.id)).state, ChangeState.ReviewReady);
    assert.equal(await store.verifyAuditChain(change.id), true);
    assert.deepEqual((await store.readAudit(change.id)).map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("maintainer identity persists and agent grants are capability-bound and expiring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-identity-"));
  try {
    const identities = new IdentityStore(path.join(root, "persistent"));
    const maintainer = await identities.createOrLoadMaintainer();
    assert.equal((await identities.createOrLoadMaintainer()).publicKeyPem, maintainer.publicKeyPem);
    assert.equal((await stat(maintainer.privateKeyPath)).mode & 0o077, 0);
    const agent = await identities.createEphemeral(path.join(root, "run-keys"), "agent_a");
    const stranger = await identities.createEphemeral(path.join(root, "other-keys"), "agent_b");
    const key = createWorkspaceMasterKey();
    const now = new Date("2026-07-18T12:00:00.000Z");
    const grant = createAgentGrant({ changeId: "change_test", workspaceMasterKey: key, recipient: agent, capabilities: ["read", "modify"], now, ttlMs: 60_000 });
    assert.deepEqual(await unwrapGrant(grant, agent, "modify", new Date(now.getTime() + 1)), key);
    await assert.rejects(() => unwrapGrant(grant, agent, "publish", now), /lacks/);
    await assert.rejects(() => unwrapGrant(grant, stranger, "read", now), /recipient/);
    await assert.rejects(() => unwrapGrant(grant, agent, "read", new Date(now.getTime() + 60_000)), /expired/);
    const tampered = { ...grant, capabilities: [...grant.capabilities, "publish" as const] };
    await assert.rejects(() => unwrapGrant(tampered, agent, "publish", now));
    assert.throws(() => createAgentGrant({ changeId: "change_test", workspaceMasterKey: key, recipient: agent, capabilities: ["read"], ttlMs: 31 * 60_000 }), /30 minutes/);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("maintainer identity survives canonical platform path aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-identity-alias-"));
  try {
    const actual = path.join(root, "actual");
    const alias = path.join(root, "alias");
    await mkdir(actual);
    await symlink(actual, alias, "dir");
    const created = await new IdentityStore(path.join(alias, "identities")).createOrLoadMaintainer();
    const reloaded = await new IdentityStore(path.join(actual, "identities")).createOrLoadMaintainer();
    assert.equal(reloaded.publicKeyPem, created.publicKeyPem);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("encrypted object addresses are private, typed, and authenticated", () => {
  const key = createWorkspaceMasterKey();
  const plaintext = Buffer.from("confidential payload");
  const first = encryptObject(key, "change_test", "file", plaintext);
  const duplicate = encryptObject(key, "change_test", "file", plaintext);
  const evidence = encryptObject(key, "change_test", "evidence", plaintext);
  const otherChange = encryptObject(key, "change_other", "file", plaintext);
  assert.equal(first.objectId, duplicate.objectId);
  assert.notEqual(first.nonce, duplicate.nonce);
  assert.notEqual(first.objectId, evidence.objectId);
  assert.notEqual(first.objectId, otherChange.objectId);
  assert.deepEqual(decryptObject(key, first, "file"), plaintext);
  assert.throws(() => decryptObject(key, first, "manifest"));
  assert.throws(() => decryptObject(key, { ...first, authenticationTag: `${first.authenticationTag.slice(0, -2)}AA` }, "file"));
  assert.throws(() => decryptObject(key, { ...first, nonce: "not-base64" }, "file"), /base64/);
  assert.throws(() => decryptObject(key, { ...first, changeId: "../other" }, "file"), /Unsafe identifier/);
});

test("event stores coordinate across instances and recover locks left by dead processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-event-locks-"));
  try {
    const metadata = path.join(root, "metadata");
    const first = new JsonEventStore(metadata);
    const second = new JsonEventStore(metadata);
    await first.initialize();
    const stale = path.join(metadata, "locks", "change_test.lock");
    await mkdir(stale);
    await writeFile(path.join(stale, "owner.json"), JSON.stringify({ version: 1, token: "stale-owner", pid: 2_147_483_647, hostname: os.hostname() }));
    await first.createChange({ id: "change_test", title: "Fix", description: "Private fix", base, ownerIdentityId: "maintainer" });
    await Promise.all([
      first.appendAudit("change_test", "identity.created", "maintainer", { source: "first" }),
      second.appendAudit("change_test", "identity.created", "maintainer", { source: "second" }),
    ]);
    assert.deepEqual((await first.readAudit("change_test")).map(({ sequence }) => sequence), [1, 2, 3]);
    assert.equal(await first.verifyAuditChain("change_test"), true);
  } finally { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); }
});

test("snapshot capture rejects hard links and portable path collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-snapshot-path-safety-"));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "original.txt"), "same inode");
    await link(path.join(source, "original.txt"), path.join(source, "alias.txt"));
    const snapshots = new EncryptedSnapshotStore(path.join(root, "store"));
    const key = createWorkspaceMasterKey();
    await assert.rejects(() => snapshots.capture({ masterKey: key, changeId: "change_hardlink", sourceDirectory: source, parentSnapshotId: null, actorIdentityId: "maintainer", reason: "import", eventSequence: 0 }), /Hard-linked/);
    await import("node:fs/promises").then(({ unlink }) => unlink(path.join(source, "alias.txt")));
    await writeFile(path.join(source, "README.md"), "upper");
    await writeFile(path.join(source, "readme.md"), "lower");
    if ((await readdir(source)).filter((name) => name.toLowerCase() === "readme.md").length === 2) {
      await assert.rejects(() => snapshots.capture({ masterKey: key, changeId: "change_collision", sourceDirectory: source, parentSnapshotId: null, actorIdentityId: "maintainer", reason: "import", eventSequence: 0 }), /collide across supported filesystems/);
    }
  } finally { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); }
});

test("encrypted snapshot branches are independent, round-trip bytes, and preserve executable modes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-snapshots-"));
  try {
    const source = path.join(root, "source");
    await mkdir(path.join(source, "bin"), { recursive: true });
    await writeFile(path.join(source, "README.md"), "base\n");
    await mkdir(path.join(source, ".veil"));
    await writeFile(path.join(source, ".veil", "config.json"), '{"contextId":"must-not-capture"}\n');
    await writeFile(path.join(source, "bin", "run"), "#!/bin/sh\n");
    await chmod(path.join(source, "bin", "run"), 0o755);
    const key = createWorkspaceMasterKey();
    const snapshots = new EncryptedSnapshotStore(path.join(root, "store"));
    const parent = await snapshots.capture({ masterKey: key, changeId: "change_test", sourceDirectory: source, parentSnapshotId: null, actorIdentityId: "maintainer", reason: "import", eventSequence: 0 });
    await writeFile(path.join(source, "README.md"), "first edit\n");
    const childA = await snapshots.captureAutomatic({ masterKey: key, changeId: "change_test", sourceDirectory: source, parentSnapshotId: parent.id, actorIdentityId: "actor_a", eventSequence: 1, final: true });
    await writeFile(path.join(source, "README.md"), "second edit\n");
    const childB = await snapshots.captureAutomatic({ masterKey: key, changeId: "change_test", sourceDirectory: source, parentSnapshotId: parent.id, actorIdentityId: "actor_b", eventSequence: 1, final: true });
    assert.notEqual(childA.treeHash, childB.treeHash);
    assert.equal(childA.parentSnapshotId, childB.parentSnapshotId);
    const targetA = path.join(root, "target-a");
    const targetB = path.join(root, "target-b");
    await snapshots.materialize({ masterKey: key, snapshot: childA, targetDirectory: targetA });
    await snapshots.materialize({ masterKey: key, snapshot: childB, targetDirectory: targetB });
    assert.equal(await readFile(path.join(targetA, "README.md"), "utf8"), "first edit\n");
    await assert.rejects(() => stat(path.join(targetA, ".veil")), /ENOENT/);
    assert.equal(await readFile(path.join(targetB, "README.md"), "utf8"), "second edit\n");
    assert.equal((await stat(path.join(targetA, "bin", "run"))).mode & 0o777, 0o755);
    const manifestRaw = await readFile(path.join(root, "store", "objects", `${childA.encryptedManifestObjectId}.json`), "utf8");
    assert.equal(manifestRaw.includes("README.md"), false);
    const [parallelA, parallelB] = await Promise.all([
      snapshots.captureAutomatic({ masterKey: key, changeId: "change_test", sourceDirectory: source, parentSnapshotId: childB.id, actorIdentityId: "actor_a", eventSequence: 2 }),
      snapshots.captureAutomatic({ masterKey: key, changeId: "change_test", sourceDirectory: source, parentSnapshotId: childB.id, actorIdentityId: "actor_b", eventSequence: 2 }),
    ]);
    assert.equal(parallelA.encryptedManifestObjectId, parallelB.encryptedManifestObjectId);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("snapshot header authentication rejects protected-field tampering and cross-change keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-snapshot-header-auth-"));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "README.md"), "authenticated\n");
    const key = createWorkspaceMasterKey();
    const wrongKey = createWorkspaceMasterKey();
    const snapshots = new EncryptedSnapshotStore(path.join(root, "store"));
    const snapshot = await snapshots.capture({
      masterKey: key,
      changeId: "change_authenticated",
      sourceDirectory: source,
      parentSnapshotId: null,
      actorIdentityId: "maintainer",
      reason: "import",
      eventSequence: 0,
    });
    await snapshots.readSnapshot(snapshot.id, key);
    await assert.rejects(
      snapshots.readSnapshot(snapshot.id, wrongKey),
      /header authentication failed/,
    );
    for (const tampered of [
      { ...snapshot, changeId: "change_substituted" },
      { ...snapshot, parentSnapshotId: "snapshot_substituted" },
      { ...snapshot, actorIdentityId: "attacker" },
      { ...snapshot, reason: "agent_final" as const },
      { ...snapshot, eventSequence: 1 },
      { ...snapshot, encryptedManifestObjectId: "f".repeat(64) },
    ]) {
      await assert.rejects(
        snapshots.materialize({ masterKey: key, snapshot: tampered, targetDirectory: path.join(root, `target-${Math.random()}`) }),
        /header authentication failed/,
      );
    }
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("manual workspace registry is encrypted and survives a new registry instance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-workspace-registry-"));
  try {
    const first = new DurableManualWorkspaceRegistry(root);
    const record = {
      version: 1 as const, id: "view_123", apiChangeId: "change_api", changeId: "change_engine",
      sourceSnapshotId: "snapshot_root", directory: "/safe/manual/workspace", runRootPath: "/safe/manual",
      runRootToken: "a".repeat(64), nextEventSequence: 4, state: "open" as const,
      createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z",
    };
    await first.save(record);
    const raw = await readFile(path.join(root, "records", "view_123.json"), "utf8");
    assert.equal(raw.includes("change_engine"), false);
    const second = new DurableManualWorkspaceRegistry(root);
    assert.deepEqual(await second.get(record.id), record);
    await second.remove(record.id);
    assert.equal(await second.get(record.id), undefined);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("manual workspace registry rejects missing required IDs and ignores unrelated record files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-workspace-registry-validation-"));
  try {
    const registry = new DurableManualWorkspaceRegistry(root);
    const valid = {
      version: 1 as const, id: "view_123", apiChangeId: "change_api", changeId: "change_engine",
      sourceSnapshotId: "snapshot_root", directory: "/safe/manual/workspace", runRootPath: "/safe/manual",
      runRootToken: "a".repeat(64), nextEventSequence: 4, state: "open" as const,
      createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z",
    };
    await assert.rejects(
      () => registry.save({ ...valid, apiChangeId: undefined } as unknown as typeof valid),
      /Invalid manual workspace record/,
    );
    await registry.save(valid);
    await writeFile(path.join(root, "records", "operator note.json"), "not a registry record\n");
    assert.deepEqual(await registry.list(), [valid]);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("manual views can resume a guarded workspace in a new command-scoped host", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-manual-resume-"));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "README.md"), "before\n");
    const key = createWorkspaceMasterKey();
    const snapshots = new EncryptedSnapshotStore(path.join(root, "store"));
    const sourceSnapshot = await snapshots.capture({ masterKey: key, changeId: "change_test", sourceDirectory: source, parentSnapshotId: null, actorIdentityId: "maintainer", reason: "import", eventSequence: 0 });
    const views = path.join(root, "views");
    const original = await new ManualSnapshotViewManager(snapshots).open({
      viewsDirectory: views, masterKey: key, changeId: "change_test", snapshotId: sourceSnapshot.id,
      actorIdentityId: "maintainer", authorizeSnapshot: () => true,
    });
    await writeFile(path.join(original.directory, "README.md"), "resumed edit\n");
    await mkdir(path.join(original.directory, ".veil"));
    await writeFile(path.join(original.directory, ".veil", "config.json"), "{\"version\":1}\n");
    const runRoot = path.dirname(original.directory);
    const marker = JSON.parse(await readFile(path.join(runRoot, ".veil-run-root.json"), "utf8")) as { token: string };
    const resumed = await new ManualSnapshotViewManager(snapshots).resume({
      viewsDirectory: views, masterKey: key, changeId: "change_test", snapshotId: sourceSnapshot.id,
      actorIdentityId: "maintainer", authorizeSnapshot: () => true,
      runRootPath: runRoot, runRootToken: marker.token, directory: original.directory,
    });
    const captured = await resumed.capture({ eventSequence: 1 });
    const restored = path.join(root, "restored");
    await snapshots.materialize({ masterKey: key, snapshot: captured, targetDirectory: restored });
    assert.equal(await readFile(path.join(restored, "README.md"), "utf8"), "resumed edit\n");
    await assert.rejects(() => stat(path.join(restored, ".veil")), /ENOENT/);
    await resumed.destroy();
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("cleanup cannot cross a marked run root", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "veil-cleanup-parent-"));
  const run = await createSafeRunRoot(parent, "run_test");
  const child = path.join(run.path, "workspace");
  await mkdir(child);
  await assert.rejects(() => safeRemoveRunPath(parent, run), /outside/);
  await assert.rejects(() => safeRemoveRunPath(run.path, { ...run, token: "wrong" }, true), /marker/);
  await safeRemoveRunPath(child, run);
  await safeRemoveRunPath(run.path, run, true);
  await import("node:fs/promises").then(({ rm }) => rm(parent, { recursive: true, force: true }));
});

test("manual snapshot views capture edits as immutable children and destroy plaintext", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-manual-view-"));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "README.md"), "before\n");
    const key = createWorkspaceMasterKey();
    const snapshots = new EncryptedSnapshotStore(path.join(root, "store"));
    const parent = await snapshots.capture({ masterKey: key, changeId: "change_test", sourceDirectory: source, parentSnapshotId: null, actorIdentityId: "maintainer", reason: "import", eventSequence: 0 });
    const manager = new ManualSnapshotViewManager(snapshots);
    const view = await manager.open({
      viewsDirectory: path.join(root, "views"), masterKey: key, changeId: "change_test", snapshotId: parent.id, actorIdentityId: "maintainer",
      authorizeSnapshot: (snapshot) => snapshot.id === parent.id,
    });
    assert.deepEqual(view.launchDescriptors.map((entry) => entry.kind), ["vscode", "cursor", "terminal", "copy-path"]);
    assert.equal(view.launchDescriptors.every((entry) => entry.directory === view.directory), true);
    assert.equal((await stat(view.directory)).mode & 0o077, 0);
    await writeFile(path.join(view.directory, "README.md"), "edited\n");
    const child = await view.capture({ eventSequence: 1 });
    assert.equal(child.reason, "manual");
    assert.equal(child.parentSnapshotId, parent.id);
    const restored = path.join(root, "restored");
    await snapshots.materialize({ masterKey: key, snapshot: child, targetDirectory: restored });
    assert.equal(await readFile(path.join(restored, "README.md"), "utf8"), "edited\n");
    await writeFile(path.join(view.directory, ".env"), "TOKEN=must-not-be-captured\n");
    await assert.rejects(() => view.capture({ eventSequence: 2 }), /forbidden/);
    await view.destroy();
    await assert.rejects(() => stat(view.directory), /ENOENT/);
    await view.destroy();
    await assert.rejects(() => view.capture({ eventSequence: 3 }), /destroyed/);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("manual views autosnapshot debounced changes, deduplicate trees, and preserve an explicit final chain", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-manual-autosnapshot-"));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "README.md"), "before\n");
    const key = createWorkspaceMasterKey();
    const snapshots = new EncryptedSnapshotStore(path.join(root, "store"));
    const parent = await snapshots.capture({ masterKey: key, changeId: "change_test", sourceDirectory: source, parentSnapshotId: null, actorIdentityId: "maintainer", reason: "import", eventSequence: 0 });
    const view = await new ManualSnapshotViewManager(snapshots).open({
      viewsDirectory: path.join(root, "views"), masterKey: key, changeId: "change_test", snapshotId: parent.id, actorIdentityId: "maintainer", authorizeSnapshot: () => true,
    });
    t.after(() => view.destroy());
    let nextSequence = 10;
    view.startAutosnapshots({ debounceMs: 30, eventSequence: () => nextSequence++ });
    await writeFile(path.join(view.directory, "README.md"), "first\n");
    await writeFile(path.join(view.directory, "README.md"), "first\n");
    await waitFor(() => view.latestAutosnapshot !== null);
    const first = view.latestAutosnapshot!;
    assert.equal(first.parentSnapshotId, parent.id);
    assert.equal(view.autosnapshotStatus.active, true);
    assert.equal(view.autosnapshotStatus.capturing, false);

    // A notification without a different tree must not create another record.
    await writeFile(path.join(view.directory, "README.md"), "first\n");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(view.latestAutosnapshot?.id, first.id);

    await writeFile(path.join(view.directory, "README.md"), "second\n");
    await waitFor(() => view.latestAutosnapshot?.id !== first.id);
    const second = view.latestAutosnapshot!;
    assert.equal(second.parentSnapshotId, first.id);
    const final = await view.capture({ eventSequence: nextSequence++, parent: "latest-autosnapshot" });
    assert.equal(final.parentSnapshotId, second.id);
    // Autosnapshots are ordinary snapshots only; this view never selects or promotes a candidate.
    assert.equal(final.reason, "manual");
    view.stopAutosnapshots();
    assert.equal(view.autosnapshotStatus.active, false);
    await view.destroy();
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("manual autosnapshots reject unsafe workspace entries and destroy cancels pending captures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-manual-autosnapshot-safety-"));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "README.md"), "before\n");
    const key = createWorkspaceMasterKey();
    const snapshots = new EncryptedSnapshotStore(path.join(root, "store"));
    const parent = await snapshots.capture({ masterKey: key, changeId: "change_test", sourceDirectory: source, parentSnapshotId: null, actorIdentityId: "maintainer", reason: "import", eventSequence: 0 });
    const manager = new ManualSnapshotViewManager(snapshots);
    const view = await manager.open({
      viewsDirectory: path.join(root, "views"), masterKey: key, changeId: "change_test", snapshotId: parent.id, actorIdentityId: "maintainer", authorizeSnapshot: () => true,
    });
    view.startAutosnapshots({ debounceMs: 20, eventSequence: 1 });
    await writeFile(path.join(view.directory, ".env"), "TOKEN=never-capture\n");
    await waitFor(() => view.autosnapshotStatus.lastError !== null);
    assert.match(view.autosnapshotStatus.lastError!, /forbidden/);
    await assert.rejects(() => view.validateWorkspace(), /forbidden/);
    assert.equal(view.latestAutosnapshot, null);
    await view.destroy();

    const secondView = await manager.open({
      viewsDirectory: path.join(root, "views"), masterKey: key, changeId: "change_test", snapshotId: parent.id, actorIdentityId: "maintainer", authorizeSnapshot: () => true,
    });
    await symlink("README.md", path.join(secondView.directory, "linked-readme"));
    await assert.rejects(() => secondView.capture({ eventSequence: 2 }), /unsafe file/);
    secondView.startAutosnapshots({ debounceMs: 100, eventSequence: 3 });
    await writeFile(path.join(secondView.directory, "README.md"), "changed\n");
    await secondView.destroy();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    assert.equal(secondView.latestAutosnapshot, null);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("manual views reject unauthorized lineage, unsafe roots, and credential or git content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-manual-reject-"));
  try {
    const source = path.join(root, "source");
    await mkdir(path.join(source, ".git"), { recursive: true });
    await writeFile(path.join(source, ".git", "config"), "secret git configuration");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=not-for-an-editor\n");
    const key = createWorkspaceMasterKey();
    const snapshots = new EncryptedSnapshotStore(path.join(root, "store"));
    const sensitive = await snapshots.capture({ masterKey: key, changeId: "change_test", sourceDirectory: source, parentSnapshotId: null, actorIdentityId: "maintainer", reason: "import", eventSequence: 0 });
    const manager = new ManualSnapshotViewManager(snapshots);
    await assert.rejects(() => manager.open({
      viewsDirectory: path.join(root, "views"), masterKey: key, changeId: "change_test", snapshotId: sensitive.id, actorIdentityId: "maintainer", authorizeSnapshot: () => true,
    }), /forbidden/);
    await assert.rejects(() => manager.open({
      viewsDirectory: path.parse(root).root, masterKey: key, changeId: "change_test", snapshotId: sensitive.id, actorIdentityId: "maintainer", authorizeSnapshot: () => true,
    }), /filesystem root/);
    await assert.rejects(() => manager.open({
      viewsDirectory: path.join(root, "views"), masterKey: key, changeId: "change_other", snapshotId: sensitive.id, actorIdentityId: "maintainer", authorizeSnapshot: () => true,
    }), /requested change/);
    await assert.rejects(() => manager.open({
      viewsDirectory: path.join(root, "views"), masterKey: key, changeId: "change_test", snapshotId: sensitive.id, actorIdentityId: "maintainer", authorizeSnapshot: () => false,
    }), /authorized/);
    assert.equal(await import("node:fs/promises").then(({ access }) => access(path.join(root, "views")).then(() => true, () => false)), false);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test("snapshot exclusions are recipe-specific rather than globally Node-specific", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-snapshot-exclusions-"));
  try {
    const source = path.join(root, "source");
    await Promise.all([
      mkdir(path.join(source, "node_modules"), { recursive: true }),
      mkdir(path.join(source, "target"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(source, "node_modules", "generated.js"), "generated\n"),
      writeFile(path.join(source, "target", "source.txt"), "legitimate source\n"),
      writeFile(path.join(source, "main.py"), "print('ok')\n"),
    ]);
    const key = createWorkspaceMasterKey();
    const snapshots = new EncryptedSnapshotStore(path.join(root, "store"));
    const universal = await snapshots.capture({ masterKey: key, changeId: "change_universal", sourceDirectory: source, parentSnapshotId: null, actorIdentityId: "maintainer", reason: "import", eventSequence: 0 });
    const universalManifest = await snapshots.readManifest(key, universal);
    assert.ok(universalManifest.files.some((file) => file.path === "node_modules/generated.js"));
    assert.ok(universalManifest.files.some((file) => file.path === "target/source.txt"));

    const node = await snapshots.capture({ masterKey: key, changeId: "change_node", sourceDirectory: source, parentSnapshotId: null, actorIdentityId: "maintainer", reason: "import", eventSequence: 0, excludePaths: ["node_modules"] });
    const nodeManifest = await snapshots.readManifest(key, node);
    assert.ok(!nodeManifest.files.some((file) => file.path.startsWith("node_modules/")));
    assert.ok(nodeManifest.files.some((file) => file.path === "target/source.txt"));
  } finally { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); }
});
