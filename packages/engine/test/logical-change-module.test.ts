import assert from "node:assert/strict";
import test from "node:test";
import { LogicalChangeModule } from "../src/logical-change-module.js";

const FIXED_TIME = "2026-08-09T12:00:00.000Z";

function createModule() {
  let sequence = 0;
  return new LogicalChangeModule({
    workspaceId: "workspace_1",
    now: () => FIXED_TIME,
    nextId: (prefix) => `${prefix}_${++sequence}`,
  });
}

test("naming Unassigned Change creates a fresh Unassigned Change and supports concurrent work", () => {
  const module = createModule();
  const initial = module.read();

  const named = module.act({
    requestId: "request_name",
    kind: "name",
    changeId: initial.unassignedChangeId,
    title: "Add profile validation",
  });

  assert.equal(named.changes.length, 2);
  assert.equal(named.changes.find((change) => change.id === initial.unassignedChangeId)?.title, "Add profile validation");
  assert.notEqual(named.unassignedChangeId, initial.unassignedChangeId);

  const created = module.act({ requestId: "request_create", kind: "create", title: "Renew profile cache" });
  assert.deepEqual(created.changes.map((change) => change.title), [
    "Add profile validation",
    "Unassigned Change",
    "Renew profile cache",
  ]);
});

test("automatic assignment prefers work-session focus and sends ambiguity to Unassigned Change", () => {
  const module = createModule();
  const initial = module.read();
  const first = module.act({ requestId: "request_first", kind: "name", changeId: initial.unassignedChangeId, title: "Profile validation" });
  const validationId = initial.unassignedChangeId;
  const cache = module.act({ requestId: "request_cache", kind: "create", title: "Profile cache" });
  const cacheId = cache.changes.find((change) => change.title === "Profile cache")!.id;

  module.act({ requestId: "request_focus", kind: "focus", changeId: validationId, sessionId: "session_agent" });
  const synchronized = module.synchronize({
    requestId: "request_sync",
    fragments: [
      { id: "fragment_focused", paths: ["src/profile.ts"], sessionId: "session_agent" },
      { id: "fragment_ambiguous", paths: ["src/shared.ts"] },
    ],
  });

  assert.equal(synchronized.fragments.find((fragment) => fragment.id === "fragment_focused")?.changeId, validationId);
  assert.equal(synchronized.fragments.find((fragment) => fragment.id === "fragment_focused")?.assignment.mode, "session");
  assert.equal(synchronized.fragments.find((fragment) => fragment.id === "fragment_ambiguous")?.changeId, first.unassignedChangeId);
  assert.equal(synchronized.fragments.find((fragment) => fragment.id === "fragment_ambiguous")?.assignment.mode, "unassigned");
  assert.equal(synchronized.changes.find((change) => change.id === cacheId)?.fragmentIds.length, 0);
});

test("assignment, split, combine, pause, resume, abandon, and deliver preserve exactly-one ownership", () => {
  const module = createModule();
  const initial = module.read();
  module.act({ requestId: "request_name", kind: "name", changeId: initial.unassignedChangeId, title: "Profile work" });
  const sourceId = initial.unassignedChangeId;
  module.synchronize({
    requestId: "request_sync",
    fragments: [
      { id: "fragment_validation", paths: ["src/validate.ts"], sessionId: "session_profile" },
      { id: "fragment_cache", paths: ["src/cache.ts"], sessionId: "session_profile" },
    ],
  });
  module.act({ requestId: "request_assign_1", kind: "assign", fragmentIds: ["fragment_validation", "fragment_cache"], toChangeId: sourceId });

  const split = module.act({
    requestId: "request_split",
    kind: "split",
    changeId: sourceId,
    parts: [
      { title: "Validate profiles", fragmentIds: ["fragment_validation"] },
      { title: "Cache profiles", fragmentIds: ["fragment_cache"] },
    ],
    remainder: "move-to-unassigned",
  });
  const validationId = split.changes.find((change) => change.title === "Validate profiles")!.id;
  const cacheId = split.changes.find((change) => change.title === "Cache profiles")!.id;

  module.act({ requestId: "request_pause", kind: "transition", changeId: cacheId, to: "paused" });
  module.act({ requestId: "request_resume", kind: "transition", changeId: cacheId, to: "active" });
  const combined = module.act({ requestId: "request_combine", kind: "combine", changeIds: [validationId, cacheId], title: "Profile validation and cache" });
  const combinedChange = combined.changes.find((change) => change.title === "Profile validation and cache")!;
  assert.deepEqual(combinedChange.fragmentIds, ["fragment_validation", "fragment_cache"]);
  assert.equal(new Set(combined.fragments.map((fragment) => fragment.id)).size, combined.fragments.length);
  assert.equal(combined.fragments.every((fragment) => combined.changes.filter((change) => change.fragmentIds.includes(fragment.id)).length === 1), true);

  module.act({ requestId: "request_abandon", kind: "transition", changeId: combinedChange.id, to: "abandoned" });
  assert.throws(
    () => module.act({ requestId: "request_bad_deliver", kind: "transition", changeId: combinedChange.id, to: "delivered" }),
    /abandoned Logical Change cannot transition to delivered/,
  );
});

test("mutation request IDs are exactly-once and conflicting reuse fails", () => {
  const module = createModule();
  const command = { requestId: "request_create", kind: "create", title: "Profile validation" } as const;
  const first = module.act(command);
  const retry = module.act(command);
  assert.deepEqual(retry, first);
  assert.throws(
    () => module.act({ requestId: "request_create", kind: "create", title: "Different work" }),
    /request ID was already used with different input/,
  );
});

test("Recovery Anchors are created at meaningful boundaries rather than idle time", () => {
  const module = createModule();
  module.synchronize({
    requestId: "request_small_edit",
    source: { workspaceTreeId: `sha256:${"a".repeat(64)}`, changedLines: 3, cause: "filesystem-change" },
    fragments: [{ id: "fragment_small", paths: ["src/profile.ts"] }],
  });
  assert.equal(module.read().recoveryAnchors.length, 0);

  module.synchronize({
    requestId: "request_action",
    source: { workspaceTreeId: `sha256:${"b".repeat(64)}`, changedLines: 12, cause: "coherent-action" },
    fragments: [{ id: "fragment_small", paths: ["src/profile.ts"] }],
  });
  assert.deepEqual(module.read().recoveryAnchors.map((anchor) => anchor.trigger), ["coherent-action"]);

  module.synchronize({
    requestId: "request_same_tree",
    source: { workspaceTreeId: `sha256:${"b".repeat(64)}`, changedLines: 500, cause: "meaningful-volume" },
    fragments: [{ id: "fragment_small", paths: ["src/profile.ts"] }],
  });
  assert.deepEqual(module.read().recoveryAnchors.map((anchor) => anchor.trigger), ["coherent-action", "meaningful-volume"]);
  assert.equal(module.read().recoveryAnchors.every((anchor) => anchor.restorable === false), true);
  assert.throws(
    () => module.act({ requestId: "preview_metadata_only", kind: "restore.preview", anchorId: module.read().recoveryAnchors[0]!.id }),
    /not restorable/,
  );
});

test("Recovery Anchor preview and apply fail closed without exact source and ownership backing", () => {
  const module = createModule();
  module.synchronize({
    requestId: "sync_backed",
    source: { workspaceTreeId: `sha256:${"a".repeat(64)}`, sourceReference: "snapshot_backed", changedLines: 1, cause: "coherent-action" },
    fragments: [{ id: "fragment_backed", paths: ["src/backed.ts"] }],
  });
  module.synchronize({
    requestId: "sync_current",
    source: { workspaceTreeId: `sha256:${"b".repeat(64)}`, sourceReference: "snapshot_current", changedLines: 1, cause: "filesystem-change" },
    fragments: [{ id: "fragment_backed", paths: ["src/backed.ts"] }],
  });
  const anchorId = module.read().recoveryAnchors[0]!.id;
  const previewId = module.act({ requestId: "preview_backed", kind: "restore.preview", anchorId }).restorePreviews[0]!.id;

  for (const corrupt of ["source", "ownership"] as const) {
    const state = module.exportState();
    const anchor = state.recoveryAnchors.find((candidate) => candidate.id === anchorId)!;
    if (corrupt === "source") delete anchor.sourceReference;
    else anchor.ownershipState = { ...anchor.ownershipState!, unassignedChangeId: "missing_change" };
    const resumed = new LogicalChangeModule({ workspaceId: "workspace_1", initialState: state, now: () => FIXED_TIME });
    assert.equal(resumed.read().recoveryAnchors.find((candidate) => candidate.id === anchorId)?.restorable, false);
    assert.equal(resumed.read().restorePreviews.some((candidate) => candidate.id === previewId), false);
    assert.throws(
      () => resumed.act({ requestId: `apply_${corrupt}`, kind: "restore.apply", previewId, confirmation: "restore-previewed-source" }),
      /not restorable|does not match/,
    );
  }
});

test("assignment precedence is explicit, then focus, then lineage, then unique inference", () => {
  const module = createModule();
  const initial = module.read();
  module.act({ requestId: "name_first", kind: "name", changeId: initial.unassignedChangeId, title: "First same-file change" });
  const second = module.act({ requestId: "create_second", kind: "create", title: "Second same-file change" });
  const secondId = second.changes.find((change) => change.title === "Second same-file change")!.id;
  module.synchronize({ requestId: "sync_parent", fragments: [{ id: "parent", paths: ["src/shared.ts"] }] });
  module.act({ requestId: "assign_parent", kind: "assign", fragmentIds: ["parent"], toChangeId: initial.unassignedChangeId });
  module.act({ requestId: "focus_second", kind: "focus", changeId: secondId, sessionId: "session_second" });

  const focused = module.synchronize({
    requestId: "sync_focused_child",
    fragments: [
      { id: "parent", paths: ["src/shared.ts"] },
      { id: "focused_child", paths: ["src/shared.ts"], sessionId: "session_second", parentFragmentId: "parent" },
    ],
  });
  assert.deepEqual(focused.fragments.find((fragment) => fragment.id === "focused_child")?.assignment, {
    mode: "session",
    confidence: 1,
    reason: "Focused work session session_second",
  });
  assert.equal(focused.fragments.find((fragment) => fragment.id === "focused_child")?.changeId, secondId);

  module.act({ requestId: "explicit_override", kind: "assign", fragmentIds: ["focused_child"], toChangeId: initial.unassignedChangeId });
  const explicit = module.synchronize({
    requestId: "sync_explicit_override",
    fragments: [{ id: "focused_child", paths: ["src/shared.ts"], sessionId: "session_second", parentFragmentId: "parent" }],
  });
  assert.equal(explicit.fragments[0]?.assignment.mode, "explicit");
  assert.equal(explicit.fragments[0]?.changeId, initial.unassignedChangeId);
});

test("restore is previewed, insured by a pre-restore anchor, and produces a new current Source State", () => {
  const module = createModule();
  module.synchronize({
    requestId: "request_anchor_one",
    source: { workspaceTreeId: `sha256:${"a".repeat(64)}`, sourceReference: "snapshot_one", changedLines: 20, cause: "coherent-action" },
    fragments: [{ id: "fragment_one", paths: ["src/profile.ts"] }],
  });
  module.synchronize({
    requestId: "request_anchor_two",
    source: { workspaceTreeId: `sha256:${"b".repeat(64)}`, sourceReference: "snapshot_two", changedLines: 20, cause: "checks-passed" },
    fragments: [{ id: "fragment_one", paths: ["src/profile.ts"] }],
  });
  const target = module.read().recoveryAnchors[0]!;
  const previewed = module.act({ requestId: "request_preview", kind: "restore.preview", anchorId: target.id });
  const preview = previewed.restorePreviews[0]!;
  assert.equal(preview.fromWorkspaceTreeId, `sha256:${"b".repeat(64)}`);
  assert.equal(preview.toWorkspaceTreeId, `sha256:${"a".repeat(64)}`);

  const restored = module.act({
    requestId: "request_restore",
    kind: "restore.apply",
    previewId: preview.id,
    confirmation: "restore-previewed-source",
  });
  assert.equal(restored.currentWorkspaceTreeId, `sha256:${"a".repeat(64)}`);
  assert.equal(restored.recoveryAnchors.at(-1)?.trigger, "before-restore");
  assert.equal(restored.restorePreviews.length, 0);
});

test("persisted Recovery Anchors atomically restore exact Logical Change ownership", () => {
  const first = createModule();
  const initial = first.read();
  first.act({ requestId: "name_owned_change", kind: "name", changeId: initial.unassignedChangeId, title: "Profile validation" });
  first.synchronize({
    requestId: "sync_owned_source",
    source: { workspaceTreeId: `sha256:${"1".repeat(64)}`, sourceReference: "snapshot_owned", changedLines: 1, cause: "filesystem-change" },
    fragments: [{ id: "fragment_profile", paths: ["src/profile.ts"], actor: "manual" }],
  });
  first.act({ requestId: "assign_owned_fragment", kind: "assign", fragmentIds: ["fragment_profile"], toChangeId: initial.unassignedChangeId });
  const anchored = first.act({ requestId: "mark_owned_source", kind: "mark-moment", label: "Known ownership" });
  const anchorId = anchored.recoveryAnchors[0]!.id;
  assert.deepEqual(first.exportState().recoveryAnchors[0]?.ownershipState?.fragments.map((fragment) => fragment.id), ["fragment_profile"]);

  let sequence = 100;
  const resumed = new LogicalChangeModule({
    workspaceId: "workspace_1",
    now: () => FIXED_TIME,
    nextId: (prefix) => `${prefix}_${++sequence}`,
    initialState: first.exportState(),
  });
  const later = resumed.act({ requestId: "create_later_change", kind: "create", title: "Unrelated experiment" });
  const laterChange = later.changes.find((change) => change.title === "Unrelated experiment")!;
  resumed.synchronize({
    requestId: "sync_later_source",
    source: { workspaceTreeId: `sha256:${"2".repeat(64)}`, sourceReference: "snapshot_later", changedLines: 2, cause: "filesystem-change" },
    fragments: [
      { id: "fragment_profile", paths: ["src/profile-renamed.ts"], actor: "agent", sessionId: "session_later" },
      { id: "fragment_later", paths: ["src/experiment.ts"], actor: "agent", sessionId: "session_later" },
    ],
  });
  resumed.act({ requestId: "assign_later_fragments", kind: "assign", fragmentIds: ["fragment_profile", "fragment_later"], toChangeId: laterChange.id });

  const preview = resumed.act({ requestId: "preview_owned_source", kind: "restore.preview", anchorId }).restorePreviews[0]!;
  const restored = resumed.act({
    requestId: "restore_owned_source",
    kind: "restore.apply",
    previewId: preview.id,
    confirmation: "restore-previewed-source",
  });

  assert.deepEqual(restored.changes.map(({ title, fragmentIds }) => ({ title, fragmentIds })), [
    { title: "Profile validation", fragmentIds: ["fragment_profile"] },
    { title: "Unassigned Change", fragmentIds: [] },
    { title: "Unrelated experiment", fragmentIds: [] },
  ]);
  assert.deepEqual(restored.fragments, [{
    id: "fragment_profile",
    paths: ["src/profile.ts"],
    changeId: initial.unassignedChangeId,
    actor: "manual",
    assignment: { mode: "explicit", confidence: 1, reason: "Explicit assignment" },
  }]);
  assert.equal(restored.currentWorkspaceTreeId, `sha256:${"1".repeat(64)}`);
  assert.equal(restored.currentSourceReference, "snapshot_owned");
  assert.equal(restored.recoveryAnchors.at(-1)?.trigger, "before-restore");
});

test("manual moments are pinned and rolling-anchor metadata retention compacts to twenty", () => {
  const module = createModule();
  module.synchronize({
    requestId: "request_initial_source",
    source: { workspaceTreeId: `sha256:${"0".repeat(64)}`, changedLines: 1, cause: "filesystem-change" },
    fragments: [{ id: "fragment_one", paths: ["src/profile.ts"] }],
  });
  module.act({ requestId: "request_mark", kind: "mark-moment", label: "Before profile migration" });
  for (let index = 1; index <= 25; index += 1) {
    module.synchronize({
      requestId: `request_rolling_${index}`,
      source: { workspaceTreeId: `sha256:${index.toString(16).padStart(64, "0")}`, changedLines: 50, cause: "meaningful-volume" },
      fragments: [{ id: "fragment_one", paths: ["src/profile.ts"] }],
    });
  }
  const anchors = module.read().recoveryAnchors;
  assert.equal(anchors.filter((anchor) => anchor.retention.class === "rolling").length, 20);
  assert.equal(anchors.find((anchor) => anchor.label === "Before profile migration")?.retention.class, "pinned");
});

test("durable state resumes concurrent changes, focus, anchors, and idempotent receipts", () => {
  const first = createModule();
  const initial = first.read();
  first.act({ requestId: "request_name", kind: "name", changeId: initial.unassignedChangeId, title: "Profile validation" });
  first.act({ requestId: "request_focus", kind: "focus", changeId: initial.unassignedChangeId, sessionId: "session_agent" });
  first.synchronize({
    requestId: "request_sync",
    source: { workspaceTreeId: `sha256:${"a".repeat(64)}`, changedLines: 50, cause: "meaningful-volume" },
    fragments: [{ id: "fragment_one", paths: ["src/profile.ts"], sessionId: "session_agent" }],
  });

  let sequence = 100;
  const restarted = new LogicalChangeModule({
    workspaceId: "workspace_1",
    initialState: first.exportState(),
    now: () => FIXED_TIME,
    nextId: (prefix) => `${prefix}_${++sequence}`,
  });
  assert.deepEqual(restarted.read(), first.read());
  assert.deepEqual(
    restarted.act({ requestId: "request_name", kind: "name", changeId: initial.unassignedChangeId, title: "Profile validation" }),
    first.act({ requestId: "request_name", kind: "name", changeId: initial.unassignedChangeId, title: "Profile validation" }),
  );
  const after = restarted.synchronize({
    requestId: "request_after_restart",
    fragments: [{ id: "fragment_two", paths: ["src/profile-two.ts"], sessionId: "session_agent" }],
  });
  assert.equal(after.fragments.find((fragment) => fragment.id === "fragment_two")?.changeId, initial.unassignedChangeId);
});

test("source or repository movement stales exact review/check evidence and requires renewal", () => {
  const manager = createModule();
  const tree = `sha256:${"1".repeat(64)}`;
  const anchor = `sha256:${"2".repeat(64)}`;
  manager.synchronize({ requestId: "sync_basis", fragments: [], source: { workspaceTreeId: tree, repositoryAnchorId: anchor, sourceReference: "snapshot_1", changedLines: 1, cause: "coherent-action" } });
  manager.act({ requestId: "review", kind: "record-review", reviewId: "review_1", workspaceTreeId: tree, repositoryAnchorId: anchor });
  manager.act({ requestId: "checks", kind: "record-checks", receiptIds: ["check_1"], status: "passed", workspaceTreeId: tree, repositoryAnchorId: anchor });
  assert.equal(manager.read().review?.status, "fresh");
  assert.doesNotThrow(() => manager.act({ requestId: "publish", kind: "before-publication" }));
  manager.synchronize({ requestId: "move", fragments: [], source: { workspaceTreeId: tree, repositoryAnchorId: `sha256:${"3".repeat(64)}`, sourceReference: "snapshot_1", changedLines: 0, cause: "filesystem-change" } });
  assert.equal(manager.read().review?.status, "stale");
  assert.equal(manager.read().checks?.status, "stale");
  assert.throws(() => manager.act({ requestId: "stale_publish", kind: "before-publication" }), /fresh Semantic Review/);
});

test("explicitly harmless repository movement rebinds reusable exact-source evidence", () => {
  const manager = createModule();
  const tree = `sha256:${"1".repeat(64)}`;
  const firstAnchor = `sha256:${"2".repeat(64)}`;
  const nextAnchor = `sha256:${"3".repeat(64)}`;
  manager.synchronize({ requestId: "sync_harmless_basis", fragments: [], source: { workspaceTreeId: tree, repositoryAnchorId: firstAnchor, sourceReference: "snapshot_1", changedLines: 1, cause: "coherent-action" } });
  manager.act({ requestId: "review_harmless", kind: "record-review", reviewId: "review_1", workspaceTreeId: tree, repositoryAnchorId: firstAnchor });
  manager.act({ requestId: "checks_harmless", kind: "record-checks", receiptIds: ["check_1"], status: "passed", workspaceTreeId: tree, repositoryAnchorId: firstAnchor });
  const moved = manager.synchronize({ requestId: "move_harmless", fragments: [], source: { workspaceTreeId: tree, repositoryAnchorId: nextAnchor, repositoryMovement: "harmless", sourceReference: "snapshot_1", changedLines: 0, cause: "filesystem-change" } });
  assert.equal(moved.review?.status, "fresh");
  assert.equal(moved.review?.repositoryAnchorId, nextAnchor);
  assert.equal(moved.checks?.status, "passed");
  assert.equal(moved.checks?.repositoryAnchorId, nextAnchor);
  assert.doesNotThrow(() => manager.act({ requestId: "publish_harmless", kind: "before-publication" }));
});

test("failed compound mutations restore the exact pre-command state", () => {
  const manager = createModule();
  const initial = manager.read();
  const named = manager.act({ requestId: "name_atomic", kind: "name", changeId: initial.unassignedChangeId, title: "Atomic source" });
  const declared = named.changes.find((change) => change.title === "Atomic source")!;
  manager.synchronize({ requestId: "fragment_atomic", fragments: [{ id: "fragment_1", paths: ["src/a.ts"] }], source: { workspaceTreeId: `sha256:${"4".repeat(64)}`, changedLines: 1, cause: "filesystem-change" } });
  manager.act({ requestId: "assign_atomic", kind: "assign", fragmentIds: ["fragment_1"], toChangeId: declared.id });
  const before = manager.exportState();
  assert.throws(() => manager.act({ requestId: "split_atomic", kind: "split", changeId: declared.id, parts: [
    { title: "Valid part", fragmentIds: ["fragment_1"] },
    { title: "Missing part", fragmentIds: ["missing"] },
  ], remainder: "keep" }), /work fragment not found/);
  assert.deepEqual(manager.exportState(), before);
});

test("passing checks creates a restorable milestone for the exact checked Source State", () => {
  const manager = createModule();
  const tree = `sha256:${"5".repeat(64)}`;
  const repositoryAnchor = `sha256:${"6".repeat(64)}`;
  manager.synchronize({
    requestId: "sync_checked_source",
    fragments: [],
    source: {
      workspaceTreeId: tree,
      sourceReference: "snapshot_checked",
      repositoryAnchorId: repositoryAnchor,
      changedLines: 2,
      cause: "filesystem-change",
    },
  });

  const checked = manager.act({
    requestId: "record_passing_checks",
    kind: "record-checks",
    receiptIds: ["check_unit", "check_typecheck"],
    status: "passed",
    workspaceTreeId: tree,
    repositoryAnchorId: repositoryAnchor,
  });

  assert.deepEqual(checked.recoveryAnchors.map((anchor) => ({
    trigger: anchor.trigger,
    workspaceTreeId: anchor.workspaceTreeId,
    sourceReference: anchor.sourceReference,
    retention: anchor.retention.class,
    restorable: anchor.restorable,
  })), [{
    trigger: "checks-passed",
    workspaceTreeId: tree,
    sourceReference: "snapshot_checked",
    retention: "milestone",
    restorable: true,
  }]);

  manager.act({
    requestId: "record_passing_checks_retry",
    kind: "record-checks",
    receiptIds: ["check_unit_rerun"],
    status: "passed",
    workspaceTreeId: tree,
    repositoryAnchorId: repositoryAnchor,
  });
  assert.equal(manager.read().recoveryAnchors.length, 1);
});

test("risky operations can checkpoint the current source before work while manual moments stay pinned", () => {
  const manager = createModule();
  const tree = `sha256:${"7".repeat(64)}`;
  manager.synchronize({
    requestId: "sync_before_risky_work",
    fragments: [],
    source: { workspaceTreeId: tree, sourceReference: "snapshot_safe", changedLines: 1, cause: "filesystem-change" },
  });

  manager.act({ requestId: "checkpoint_risky_work", kind: "before-risky-operation", label: "Before schema rewrite" });
  manager.act({ requestId: "mark_manual_moment", kind: "mark-moment", label: "Known-good profile flow" });

  assert.deepEqual(manager.read().recoveryAnchors.map((anchor) => ({
    trigger: anchor.trigger,
    label: anchor.label,
    sourceReference: anchor.sourceReference,
    retention: anchor.retention.class,
  })), [
    { trigger: "before-risky-operation", label: "Before schema rewrite", sourceReference: "snapshot_safe", retention: "milestone" },
    { trigger: "manual-mark", label: "Known-good profile flow", sourceReference: "snapshot_safe", retention: "pinned" },
  ]);
});

test("expired anchors stop advertising restore and cannot be previewed at the expiry boundary", () => {
  let now = Date.parse("2026-08-09T12:00:00.000Z");
  let sequence = 0;
  const manager = new LogicalChangeModule({
    workspaceId: "workspace_expiry",
    now: () => new Date(now).toISOString(),
    nextId: (prefix) => `${prefix}_${++sequence}`,
  });
  manager.synchronize({
    requestId: "sync_rolling_anchor",
    fragments: [],
    source: { workspaceTreeId: `sha256:${"8".repeat(64)}`, sourceReference: "snapshot_expiring", changedLines: 50, cause: "meaningful-volume" },
  });
  const anchor = manager.read().recoveryAnchors[0]!;

  now += 7 * 24 * 60 * 60_000 - 1;
  const preview = manager.act({ requestId: "preview_nearly_expired_anchor", kind: "restore.preview", anchorId: anchor.id })
    .restorePreviews[0]!;
  now += 1;

  const expiredView = manager.read();
  assert.equal(expiredView.recoveryAnchors[0]?.restorable, false);
  assert.deepEqual(expiredView.restorePreviews, []);
  assert.throws(
    () => manager.act({
      requestId: "apply_expired_anchor_preview",
      kind: "restore.apply",
      previewId: preview.id,
      confirmation: "restore-previewed-source",
    }),
    /expired/,
  );
  assert.throws(
    () => manager.act({ requestId: "preview_expired_anchor", kind: "restore.preview", anchorId: anchor.id }),
    /expired/,
  );
});

test("manual and agent fragments synchronize together without losing provenance or ownership", () => {
  const manager = createModule();
  const initial = manager.read();
  manager.act({ requestId: "name_manual_change", kind: "name", changeId: initial.unassignedChangeId, title: "Manual profile edits" });
  const agentView = manager.act({ requestId: "create_agent_change", kind: "create", title: "Agent profile checks" });
  const agentChange = agentView.changes.find((change) => change.title === "Agent profile checks")!;
  manager.act({ requestId: "focus_agent_change", kind: "focus", changeId: agentChange.id, sessionId: "agent_session" });

  const mixed = manager.synchronize({
    requestId: "sync_mixed_work",
    fragments: [
      { id: "manual_fragment", paths: ["src/profile-form.ts"], actor: "manual" },
      { id: "agent_fragment", paths: ["src/profile-check.ts"], actor: "agent", sessionId: "agent_session" },
    ],
  });
  assert.equal(mixed.fragments.find((fragment) => fragment.id === "manual_fragment")?.actor, "manual");
  assert.equal(mixed.fragments.find((fragment) => fragment.id === "agent_fragment")?.actor, "agent");
  assert.equal(mixed.fragments.find((fragment) => fragment.id === "manual_fragment")?.changeId, mixed.unassignedChangeId);
  assert.equal(mixed.fragments.find((fragment) => fragment.id === "agent_fragment")?.changeId, agentChange.id);

  manager.act({ requestId: "assign_manual_work", kind: "assign", fragmentIds: ["manual_fragment"], toChangeId: initial.unassignedChangeId });
  const continued = manager.synchronize({
    requestId: "sync_mixed_continuations",
    fragments: [
      { id: "manual_continuation", paths: ["src/profile-form.test.ts"], actor: "manual", parentFragmentId: "manual_fragment" },
      { id: "agent_continuation", paths: ["src/profile-check.test.ts"], actor: "agent", sessionId: "agent_session", parentFragmentId: "agent_fragment" },
    ],
  });
  assert.deepEqual(continued.fragments.map((fragment) => ({ id: fragment.id, actor: fragment.actor, changeId: fragment.changeId })), [
    { id: "manual_continuation", actor: "manual", changeId: initial.unassignedChangeId },
    { id: "agent_continuation", actor: "agent", changeId: agentChange.id },
  ]);
  assert.equal(continued.fragments.every((fragment) => continued.changes.filter((change) => change.fragmentIds.includes(fragment.id)).length === 1), true);
});

test("an unchanged fragment keeps its original actor and work-session provenance", () => {
  const manager = createModule();
  manager.synchronize({
    requestId: "sync_manual_origin",
    fragments: [{ id: "fragment_same", paths: ["src/profile.ts"], actor: "manual" }],
  });
  const continued = manager.synchronize({
    requestId: "sync_agent_result",
    fragments: [{ id: "fragment_same", paths: ["src/profile.ts"], actor: "agent", sessionId: "agent_later" }],
  });
  assert.deepEqual(continued.fragments[0], {
    id: "fragment_same",
    paths: ["src/profile.ts"],
    changeId: continued.unassignedChangeId,
    actor: "manual",
    assignment: { mode: "unassigned", confidence: 0, reason: "No unique active Logical Change matched" },
  });
});

test("failed mixed synchronization is atomic after earlier observations mutate state", () => {
  const manager = createModule();
  manager.synchronize({
    requestId: "sync_atomic_baseline",
    fragments: [{ id: "manual_fragment", paths: ["src/original.ts"], actor: "manual" }],
  });
  const before = manager.exportState();

  assert.throws(() => manager.synchronize({
    requestId: "sync_atomic_failure",
    fragments: [
      { id: "manual_fragment", paths: ["src/mutated.ts"], actor: "manual" },
      { id: "agent_fragment", paths: ["../unsafe.ts"], actor: "agent", sessionId: "agent_session" },
    ],
  }), /safe relative paths/);
  assert.deepEqual(manager.exportState(), before);
});
