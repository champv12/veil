import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDockerArgs,
  buildBubblewrapArgs,
  buildMacSandboxProfile,
  availableVerificationBackend,
  createExternalNodeTestSuite,
  createNodeVerificationPlan,
  detectVerificationRecipe,
  evaluateCandidate,
  evaluateNodeCandidate,
  materializePrivateEvaluatorSuite,
  sealPrivateEvaluatorSuite,
  validateVerificationRecipe,
  validateEvaluationTree,
} from "../src/index.js";

test("evaluation workspaces reject links and portable path collisions before sandboxing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-evaluation-tree-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "veil-evaluation-outside-"));
  try {
    await writeFile(path.join(outside, "secret"), "host data");
    await symlink(path.join(outside, "secret"), path.join(root, "escape"));
    await assert.rejects(validateEvaluationTree(root), /symbolic link/);
    await rm(path.join(root, "escape"));
    await writeFile(path.join(root, "source"), "contents");
    await link(path.join(root, "source"), path.join(root, "alias"));
    await assert.rejects(validateEvaluationTree(root), /hard-linked/);
    await rm(path.join(root, "alias"));
    await writeFile(path.join(root, "README.md"), "upper");
    await writeFile(path.join(root, "readme.md"), "lower");
    if ((await readdir(root)).filter((name) => name.toLowerCase() === "readme.md").length === 2) {
      await assert.rejects(validateEvaluationTree(root), /collide across supported filesystems/);
    }
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test("verification plan uses supported scripts and requires tests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-evaluator-test-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }));
  await writeFile(path.join(root, "package-lock.json"), "{}");
  const plan = await createNodeVerificationPlan(root);
  assert.deepEqual(plan.gates.map(({ name, argv }) => ({ name, argv })), [
    { name: "test", argv: ["npm", "run", "test"] },
    { name: "build", argv: ["npm", "run", "build"] },
  ]);
});

test("repository detection is language-neutral and leaves an unknown Python repository unchecked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-python-unchecked-"));
  try {
    await Promise.all([
      writeFile(path.join(root, "main.py"), "print('hello')\n"),
      writeFile(path.join(root, "README.md"), "Python application without a declared test recipe\n"),
    ]);
    assert.equal(await detectVerificationRecipe(root), null);
    const evaluation = await evaluateCandidate({ candidateDirectory: root, recipe: null });
    assert.equal(evaluation.status, "unchecked");
    assert.equal(evaluation.passed, false);
    assert.equal(evaluation.install.status, "skipped");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("built-in detectors cover Python, Go, and Rust without changing repository admission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-multilang-detectors-"));
  try {
    const python = path.join(root, "python");
    const go = path.join(root, "go");
    const rust = path.join(root, "rust");
    await Promise.all([mkdir(path.join(python, "tests"), { recursive: true }), mkdir(go), mkdir(rust)]);
    await Promise.all([
      writeFile(path.join(python, "pyproject.toml"), "[project.optional-dependencies]\ntest = ['pytest']\n"),
      writeFile(path.join(python, "tests", "test_ok.py"), "def test_ok(): assert True\n"),
      writeFile(path.join(go, "go.mod"), "module example.test/fixture\n\ngo 1.24\n"),
      writeFile(path.join(rust, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n"),
      writeFile(path.join(rust, "Cargo.lock"), "version = 4\n"),
    ]);
    assert.equal((await detectVerificationRecipe(python))?.profile, "python-pytest");
    assert.equal((await detectVerificationRecipe(go))?.profile, "go");
    assert.equal((await detectVerificationRecipe(rust))?.profile, "rust-cargo");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("built-in detectors cover Java, Ruby, PHP, and .NET repositories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-additional-detectors-"));
  try {
    const fixtures = [
      { directory: "maven", files: { mvnw: "#!/bin/sh\n" }, profile: "java-maven" },
      { directory: "gradle", files: { gradlew: "#!/bin/sh\n" }, profile: "java-gradle" },
      { directory: "ruby", files: { "Gemfile.lock": "GEM\n" }, profile: "ruby-bundler" },
      { directory: "php", files: { "composer.lock": "{}\n" }, profile: "php-composer" },
      { directory: "dotnet", files: { "Fixture.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />\n" }, profile: "dotnet" },
    ] as const;
    for (const fixture of fixtures) {
      const directory = path.join(root, fixture.directory);
      await mkdir(directory);
      await Promise.all(Object.entries(fixture.files).map(([name, content]) => writeFile(path.join(directory, name), content)));
      assert.equal((await detectVerificationRecipe(directory))?.profile, fixture.profile, fixture.directory);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("veil.verify.json provides a universal argv-based verification recipe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-configured-recipe-"));
  try {
    await writeFile(path.join(root, "veil.verify.json"), JSON.stringify({
      version: 2,
      source: "repository-config",
      profile: "custom-language",
      toolchains: [{ executable: "node", versionArgs: ["--version"] }],
      setup: [],
      gates: [{ name: "test", argv: ["node", "-e", "process.exit(0)"], network: "disabled", timeoutMs: 10_000, required: true }],
      ephemeralPaths: [".custom-cache"],
      protectedPaths: [],
    }));
    const recipe = await detectVerificationRecipe(root);
    assert.equal(recipe?.source, "repository-config");
    assert.deepEqual(recipe?.gates[0]?.argv, ["node", "-e", "process.exit(0)"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verification recipes reject traversal and preserve metacharacters as argv data", () => {
  const base = {
    version: 2 as const,
    source: "user-config" as const,
    profile: "custom",
    toolchains: [{ executable: "tool", versionArgs: ["--version"] }],
    setup: [],
    gates: [{ name: "test", argv: ["tool", "; touch /tmp/not-a-command"], network: "disabled" as const, timeoutMs: 5_000, required: true }],
    ephemeralPaths: [],
    protectedPaths: [],
  };
  const validated = validateVerificationRecipe(base);
  assert.equal(validated.gates[0]?.argv[1], "; touch /tmp/not-a-command");
  assert.throws(() => validateVerificationRecipe({ ...base, gates: [{ ...base.gates[0], workingDirectory: "../escape" }] }), /working directory path is invalid/);
  assert.throws(() => validateVerificationRecipe({ ...base, ephemeralPaths: ["../../secret"] }), /ephemeral path is invalid/);
  assert.throws(() => validateVerificationRecipe({ ...base, gates: [{ ...base.gates[0], argv: ["sh", "-lc", "touch /tmp/escape"] }] }), /argument vector instead of an inline shell/);
  assert.throws(() => validateVerificationRecipe({ ...base, gates: [{ ...base.gates[0], environment: { PATH: "." } }] }), /cannot override PATH/);
});

test("detector conflicts require an explicit repository recipe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-detector-conflict-"));
  try {
    await Promise.all([
      writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } })),
      writeFile(path.join(root, "package-lock.json"), "{}"),
      writeFile(path.join(root, "go.mod"), "module example.test/conflict\n"),
    ]);
    await assert.rejects(() => detectVerificationRecipe(root), /Multiple verification profiles.*veil\.verify\.json/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing configured toolchain reports unavailable instead of rejecting the repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-missing-toolchain-"));
  try {
    const recipe = validateVerificationRecipe({
      version: 2, source: "user-config", profile: "missing-tool", toolchains: [{ executable: "veil-tool-that-does-not-exist", versionArgs: ["--version"] }],
      setup: [], gates: [{ name: "test", argv: ["veil-tool-that-does-not-exist", "test"], network: "disabled", timeoutMs: 5_000, required: true }], ephemeralPaths: [], protectedPaths: [],
    });
    const evaluation = await evaluateCandidate({ candidateDirectory: root, recipe, backend: process.platform === "linux" ? "bubblewrap" : "macos-sandbox" });
    assert.equal(evaluation.status, "unavailable");
    assert.match(evaluation.errors.join("\n"), /Missing verification toolchain/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Docker verification drops capabilities and disables network for gates", () => {
  const args = buildDockerArgs({ image: "node:24-bookworm-slim", workspace: "/tmp/work", command: "npm test", network: "none", user: "1001:1001" });
  assert.ok(args.includes("--cap-drop"));
  assert.ok(args.includes("ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--user") + 1], "1001:1001");
  assert.ok(!args.join(" ").includes("docker.sock"));
});

test("native sandbox policies deny verification networking and protect private gates", () => {
  const profile = buildMacSandboxProfile({ workspace: "/tmp/candidate", home: "/tmp/home", privateSuiteDirectory: "/tmp/private", network: false, workspaceReadOnly: true });
  assert.equal(profile.includes("(deny network*)"), true);
  assert.equal(profile.includes('(require-not (subpath "/tmp/home"))'), true);
  assert.equal(profile.includes('(require-not (subpath "/tmp/candidate"))'), false);

  const args = buildBubblewrapArgs({ workspace: "/tmp/candidate", home: "/tmp/home", privateSuiteDirectory: "/tmp/private", command: "npm test", network: false, workspaceReadOnly: true });
  assert.equal(args.includes("--share-net"), false);
  assert.deepEqual(args.slice(args.indexOf("/tmp/candidate") - 1, args.indexOf("/tmp/candidate") + 2), ["--ro-bind", "/tmp/candidate", "/workspace"]);
  assert.deepEqual(args.slice(args.indexOf("/tmp/home") - 1, args.indexOf("/tmp/home") + 2), ["--bind", "/tmp/home", "/home/veil"]);
  assert.ok(args.includes(path.dirname(path.dirname(process.execPath))));
  assert.ok(args[args.indexOf("PATH") + 1]?.startsWith(`${path.dirname(process.execPath)}:`));
  assert.ok(args.includes("/veil-private-evaluator"));
});

test("macOS verifies a fresh Node candidate without Docker", { skip: process.platform !== "darwin", timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-native-evaluator-"));
  const sentinelRoot = await mkdtemp(path.join(os.tmpdir(), "veil-native-host-sentinel-"));
  try {
    await mkdir(path.join(root, "test"));
    const sentinelPath = path.join(sentinelRoot, "must-not-read.txt");
    await Promise.all([
      writeFile(path.join(root, "package.json"), JSON.stringify({ name: "native-evaluator-fixture", version: "1.0.0", private: true, scripts: { test: "node --test" } })),
      writeFile(path.join(root, "package-lock.json"), JSON.stringify({ name: "native-evaluator-fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "native-evaluator-fixture", version: "1.0.0" } } })),
      writeFile(sentinelPath, "host-only"),
      writeFile(path.join(root, "test", "works.test.js"), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { readFile } from 'node:fs/promises';",
        "import net from 'node:net';",
        "test('ordinary tests run', () => assert.equal(2 + 2, 4));",
        `test('host temp siblings are unreadable', async () => assert.rejects(readFile(${JSON.stringify(sentinelPath)}), (error) => error?.code === 'EPERM' || error?.code === 'EACCES'));`,
        "test('verification networking is denied', async () => await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', (error) => error?.code === 'EPERM' || error?.code === 'EACCES' ? resolve() : reject(error)); server.listen(0, '127.0.0.1', () => { server.close(); reject(new Error('network unexpectedly available')); }); }));",
        "",
      ].join("\n")),
    ]);
    assert.equal(await availableVerificationBackend(), "macos-sandbox");
    const evaluation = await evaluateNodeCandidate({ candidateDirectory: root, baselineDirectory: root, timeoutMsPerGate: 15_000 });
    assert.equal(evaluation.backend, "macos-sandbox", evaluation.errors.join("\n"));
    assert.equal(evaluation.install.status, "passed", JSON.stringify(evaluation));
    assert.equal(evaluation.gates.find((gate) => gate.name === "test")?.status, "passed", JSON.stringify(evaluation.gates));
    assert.equal(evaluation.passed, true, evaluation.errors.join("\n"));

    const missingSandbox = await evaluateNodeCandidate({ backend: "bubblewrap", candidateDirectory: root, baselineDirectory: root, timeoutMsPerGate: 5_000 });
    assert.equal(missingSandbox.passed, false);
    assert.equal(missingSandbox.install.status, "failed");
    assert.match(missingSandbox.install.output, /could not start/);
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(sentinelRoot, { recursive: true, force: true })]); }
});

test("private evaluator suite is encrypted and materialized only into evaluator-owned storage", async () => {
  const marker = randomUUID();
  const key = Buffer.alloc(32, 7);
  const envelope = sealPrivateEvaluatorSuite(createExternalNodeTestSuite({
    redactedName: "private-security",
    source: `// ${marker}\nexport {};`,
  }), key);
  assert.equal(JSON.stringify(envelope).includes(marker), false);
  assert.deepEqual(envelope.gates, [{ redactedName: "private-security" }]);
  const root = await mkdtemp(path.join(os.tmpdir(), "veil-private-evaluator-"));
  try {
    const suite = await materializePrivateEvaluatorSuite({ envelope, key, directory: path.join(root, "suite") });
    assert.equal(suite.gates[0]?.redactedName, "private-security");
    assert.deepEqual(suite.gates[0]?.command.argv, ["node", "--test", "{{privateSuite}}/security.test.mjs"]);
    assert.ok((await readFile(path.join(suite.directory, "security.test.mjs"), "utf8")).includes(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private evaluator mount is read-only and separate from the candidate workspace", () => {
  const args = buildDockerArgs({
    image: "node:24-bookworm-slim",
    workspace: "/tmp/candidate",
    privateSuiteDirectory: "/tmp/evaluator-only",
    workspaceReadOnly: true,
    command: "node --test /veil-private-evaluator/security.test.mjs",
    network: "none",
  });
  assert.ok(args.includes("type=bind,source=/tmp/evaluator-only,target=/veil-private-evaluator,readonly"));
  assert.ok(args.includes("type=bind,source=/tmp/candidate,target=/workspace,readonly"));
  assert.equal(args.join(" ").includes("/tmp/evaluator-only") && args.join(" ").includes("readonly"), true);
});
