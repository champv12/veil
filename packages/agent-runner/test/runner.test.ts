import assert from "node:assert/strict";
import test from "node:test";
import { chmod, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildBubblewrapArguments,
  buildCodexArgs,
  minimalCodexEnvironment,
  parseCodexJsonl,
  runCodexAgent,
  validateMaterializedWorkspace,
  validatePrivateBriefPath,
} from "../src/index.js";

test("Codex invocation is ephemeral, schema constrained, sandboxed, and network disabled", () => {
  const args = buildCodexArgs(
    {
      workspaceDirectory: "/tmp/example",
      role: { id: "minimal", name: "Codex agent", instruction: "Prefer a minimal fix." },
    },
    "/tmp/schema.json",
    "/tmp/output.json",
  );
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes("workspace-write"));
  assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(!args.join(" ").includes("GITHUB_TOKEN"));
});

test("minimal environment never inherits token variables", () => {
  const environment = minimalCodexEnvironment({
    HOME: "/tmp/home",
    CODEX_HOME: "/tmp/codex-home",
    GITHUB_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    PRIVATE_PROVIDER_API_KEY: "secret",
    PRIVATE_PROVIDER_CLIENT_ID: "secret",
    PRIVATE_PROVIDER_COOKIE_PASSWORD: "secret",
    PRIVATE_DATABASE_URL: "secret",
    PRIVATE_BACKEND_DATABASE_URL: "secret",
    PRIVATE_ANALYTICS_API_KEY: "secret",
  });
  assert.equal(environment.HOME, "/tmp/home");
  assert.equal(environment.CODEX_HOME, "/tmp/codex-home");
  for (const name of [
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "PRIVATE_PROVIDER_API_KEY",
    "PRIVATE_PROVIDER_CLIENT_ID",
    "PRIVATE_PROVIDER_COOKIE_PASSWORD",
    "PRIVATE_DATABASE_URL",
    "PRIVATE_BACKEND_DATABASE_URL",
    "PRIVATE_ANALYTICS_API_KEY",
  ]) {
    assert.equal(environment[name], undefined, `${name} must not enter Codex`);
  }
});

test("JSONL parser treats malformed agent output as evidence", () => {
  const result = parseCodexJsonl(
    '{"type":"thread.started","thread_id":"thread_1"}\nnot-json\n{"type":"item.completed"}\n',
  );
  assert.equal(result.threadId, "thread_1");
  assert.equal(result.events.length, 2);
  assert.equal(result.malformedLineCount, 1);
});

test("bubblewrap mount plan exposes no host root, home, Veil state, or sibling workspace", () => {
  const args = buildBubblewrapArguments({
    workspaceDirectory: "/tmp/run/agent-a",
    runRoot: "/tmp/runner-output",
    codexBinary: "/usr/local/bin/codex",
    codexArgs: ["exec"],
  });
  assert.ok(args.includes("--unshare-user"));
  assert.ok(args.includes("--unshare-pid"));
  assert.equal(args.includes("--unshare-net"), false);
  assert.ok(args.includes("--die-with-parent"));
  assert.deepEqual(args.filter((value) => value === "--bind").length, 2);
  assert.ok(args.includes("/tmp/run/agent-a"));
  assert.ok(!args.includes("/tmp/run/agent-b"));
  assert.equal(args.some((value, index) => value === "--bind" && args[index + 1] === "/"), false);
  assert.ok(!args.includes("/home/user"));
  assert.equal(args.includes("/home/agent"), false);
  assert.ok(!args.includes("/tmp/run/keys"));
});

test("workspace validation rejects links that could traverse into a sibling workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-runner-test-"));
  const workspace = path.join(root, "agent-a");
  const sibling = path.join(root, "agent-b");
  try {
    await mkdir(workspace);
    await mkdir(sibling);
    await writeFile(path.join(sibling, "publisher-credential"), "not mountable");
    await symlink(sibling, path.join(workspace, "sibling"));
    await assert.rejects(validateMaterializedWorkspace(workspace), /forbidden symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace validation rejects a workspace path that is itself a sibling link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-runner-test-"));
  const workspace = path.join(root, "agent-a");
  const sibling = path.join(root, "agent-b");
  try {
    await mkdir(sibling);
    await symlink(sibling, workspace);
    await assert.rejects(validateMaterializedWorkspace(workspace), /must be a real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace validation rejects hard links and case-colliding paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-runner-hardlink-"));
  try {
    await writeFile(path.join(root, "source"), "contents");
    await link(path.join(root, "source"), path.join(root, "alias"));
    await assert.rejects(validateMaterializedWorkspace(root), /hard-linked/);
    await rm(path.join(root, "alias"));
    await writeFile(path.join(root, "README.md"), "upper");
    await writeFile(path.join(root, "readme.md"), "lower");
    if ((await readdir(root)).filter((name) => name.toLowerCase() === "readme.md").length === 2) {
      await assert.rejects(validateMaterializedWorkspace(root), /colliding paths/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent timeout policy is bounded before execution", async () => {
  await assert.rejects(runCodexAgent({
    workspaceDirectory: "/tmp/unused",
    role: { id: "minimal", name: "Codex agent", instruction: "Do nothing." },
    timeoutMs: 1,
  }), /between one second and one hour/);
});

test("agent execution fails closed when structured output exceeds its event limit", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-runner-output-limit-"));
  try {
    const binary = path.join(root, "fake-codex");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(binary, "#!/bin/sh\nwhile :; do printf '%s\\n' '{\"type\":\"item.completed\"}'; done\n");
    await chmod(binary, 0o700);
    const result = await runCodexAgent({
      workspaceDirectory: workspace,
      role: { id: "minimal", name: "Codex agent", instruction: "Do nothing." },
      codexBinary: binary,
      timeoutMs: 5_000,
    });
    assert.equal(result.events.length, 10_000);
    assert.match(result.stderr, /output exceeded the safe limit/);
    assert.equal(result.exitCode, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent output byte limit kills an unterminated-line flood without buffering through grace time", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-runner-byte-limit-"));
  try {
    const binary = path.join(root, "fake-codex");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(binary, "#!/bin/sh\nwhile :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done\n");
    await chmod(binary, 0o700);
    const started = Date.now();
    const result = await runCodexAgent({
      workspaceDirectory: workspace,
      role: { id: "minimal", name: "Codex agent", instruction: "Do nothing." },
      codexBinary: binary,
      timeoutMs: 9_000,
    });
    assert.match(result.stderr, /output exceeded the safe limit/);
    assert.equal(result.exitCode, 1);
    assert.ok(Date.now() - started < 5_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private brief cannot name a host path outside the workspace", () => {
  assert.throws(() => validatePrivateBriefPath("/tmp/veil-keys/brief.md"), /must stay inside/);
  assert.throws(() => validatePrivateBriefPath("../agent-b/brief.md"), /must stay inside/);
  assert.doesNotThrow(() => validatePrivateBriefPath(".veil-private/brief.md"));
});

test("required mount isolation fails closed instead of copying Codex authentication", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "veil-runner-test-"));
  try {
    await assert.rejects(
      runCodexAgent({
        workspaceDirectory: workspace,
        role: { id: "minimal", name: "Codex agent", instruction: "Do nothing." },
        isolationMode: "required",
      }),
      /without copying or mounting credentials/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cancellation terminates ordinary descendants in the runner process group", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-runner-descendant-"));
  let descendantPid = 0;
  try {
    const binary = path.join(root, "fake-codex");
    const workspace = path.join(root, "workspace");
    const pidPath = path.join(workspace, "descendant.pid");
    await mkdir(workspace);
    await writeFile(binary, `#!/bin/sh\nsleep 60 &\necho $! > "${pidPath}"\nwait\n`);
    await chmod(binary, 0o700);
    const controller = new AbortController();
    const execution = runCodexAgent({
      workspaceDirectory: workspace,
      role: { id: "minimal", name: "Codex agent", instruction: "Do nothing." },
      codexBinary: binary,
      timeoutMs: 9_000,
      signal: controller.signal,
    });
    const deadline = Date.now() + 3_000;
    while (!descendantPid && Date.now() < deadline) {
      try { descendantPid = Number((await readFile(pidPath, "utf8")).trim()); }
      catch { await new Promise<void>((resolve) => setTimeout(resolve, 20)); }
    }
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
    controller.abort();
    const result = await execution;
    assert.equal(result.cancelled, true);
    const stoppedDeadline = Date.now() + 3_000;
    while (Date.now() < stoppedDeadline) {
      try { process.kill(descendantPid, 0); await new Promise<void>((resolve) => setTimeout(resolve, 20)); }
      catch { descendantPid = 0; break; }
    }
    assert.equal(descendantPid, 0, "ordinary descendant must not survive cancellation");
  } finally {
    if (descendantPid > 1) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});
