import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { VerificationCommandSpec, VerificationDetector, VerificationRecipeV2 } from "./types.js";

const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/;

function command(
  name: string,
  argv: [string, ...string[]],
  options: Partial<Omit<VerificationCommandSpec, "name" | "argv">> = {},
): VerificationCommandSpec {
  return {
    name,
    argv,
    network: options.network ?? "disabled",
    timeoutMs: options.timeoutMs ?? 5 * 60_000,
    required: options.required ?? true,
    ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
  };
}

async function exists(root: string, relative: string): Promise<boolean> {
  try { await access(path.join(root, relative)); return true; } catch { return false; }
}

async function isDirectory(root: string, relative: string): Promise<boolean> {
  try { return (await stat(path.join(root, relative))).isDirectory(); } catch { return false; }
}

async function text(root: string, relative: string): Promise<string | null> {
  try { return await readFile(path.join(root, relative), "utf8"); } catch { return null; }
}

function recipe(input: Omit<VerificationRecipeV2, "version" | "source"> & { source?: VerificationRecipeV2["source"] }): VerificationRecipeV2 {
  return validateVerificationRecipe({ version: 2, source: input.source ?? "detected", ...input });
}

export const nodeVerificationDetector: VerificationDetector = {
  id: "node",
  async detect(root) {
    const manifestText = await text(root, "package.json");
    if (!manifestText) return null;
    let manifest: { scripts?: Record<string, unknown> };
    try { manifest = JSON.parse(manifestText) as { scripts?: Record<string, unknown> }; } catch { return null; }
    const scripts = manifest.scripts ?? {};
    if (typeof scripts.test !== "string" || !scripts.test.trim()) return null;
    let executable: string;
    let packageManager: "npm" | "pnpm" | "yarn";
    let setup: VerificationCommandSpec;
    let runPrefix: string[];
    if (await exists(root, "package-lock.json")) {
      executable = "npm";
      packageManager = "npm";
      setup = command("install", ["npm", "ci", "--no-audit", "--no-fund"], { network: "enabled" });
      runPrefix = ["npm", "run"];
    } else if (await exists(root, "pnpm-lock.yaml")) {
      executable = "corepack";
      packageManager = "pnpm";
      setup = command("install", ["corepack", "pnpm", "install", "--frozen-lockfile"], { network: "enabled" });
      runPrefix = ["corepack", "pnpm"];
    } else if (await exists(root, "yarn.lock")) {
      executable = "corepack";
      packageManager = "yarn";
      setup = command("install", ["corepack", "yarn", "install", "--immutable"], { network: "enabled" });
      runPrefix = ["corepack", "yarn"];
    } else return null;
    const gates = ["test", "typecheck", "lint", "build"].flatMap((name) =>
      typeof scripts[name] === "string" && scripts[name]!.trim()
        ? [command(name, [runPrefix[0]!, runPrefix[1]!, name])]
        : []);
    return recipe({
      profile: `node-${packageManager}`,
      toolchains: [{ executable, versionArgs: ["--version"] }],
      setup: [setup], gates,
      container: { image: "node:24-bookworm-slim" },
      ephemeralPaths: ["node_modules"], protectedPaths: [],
    });
  },
};

export const pythonVerificationDetector: VerificationDetector = {
  id: "python",
  async detect(root) {
    const hasTests = await isDirectory(root, "tests") || (await readdir(root).catch(() => [])).some((name) => /^test.*\.py$/.test(name));
    if (await exists(root, "uv.lock")) return recipe({
      profile: "python-uv", toolchains: [{ executable: "uv", versionArgs: ["--version"] }],
      setup: [command("install", ["uv", "sync", "--frozen"], { network: "enabled" })],
      gates: [command("test", ["uv", "run", hasTests ? "pytest" : "python", ...(hasTests ? [] : ["-m", "unittest", "discover"])])],
      container: { image: "ghcr.io/astral-sh/uv:python3.13-bookworm-slim" },
      ephemeralPaths: [".venv", "__pycache__", ".pytest_cache"], protectedPaths: [],
    });
    if (await exists(root, "poetry.lock")) return recipe({
      profile: "python-poetry", toolchains: [{ executable: "poetry", versionArgs: ["--version"] }],
      setup: [command("install", ["poetry", "install", "--no-interaction"], { network: "enabled" })],
      gates: [command("test", ["poetry", "run", hasTests ? "pytest" : "python", ...(hasTests ? [] : ["-m", "unittest", "discover"])])],
      ephemeralPaths: [".venv", "__pycache__", ".pytest_cache"], protectedPaths: [],
    });
    const pyproject = await text(root, "pyproject.toml");
    const requirements = await exists(root, "requirements.txt");
    if (hasTests && (requirements || pyproject?.toLowerCase().includes("pytest"))) return recipe({
      profile: "python-pytest", toolchains: [{ executable: "python3", versionArgs: ["--version"] }],
      setup: [
        command("venv", ["python3", "-m", "venv", ".veil-python-env"]),
        command("install", [".veil-python-env/bin/python", "-m", "pip", "install", ...(requirements ? ["-r", "requirements.txt"] : ["-e", "."]), "pytest"], { network: "enabled" }),
      ],
      gates: [command("test", [".veil-python-env/bin/python", "-m", "pytest"])],
      container: { image: "python:3.13-slim" },
      ephemeralPaths: [".venv", ".veil-python-env", "__pycache__", ".pytest_cache"], protectedPaths: [],
    });
    if (hasTests) return recipe({
      profile: "python-unittest", toolchains: [{ executable: "python3", versionArgs: ["--version"] }],
      setup: [], gates: [command("test", ["python3", "-m", "unittest", "discover"])],
      container: { image: "python:3.13-slim" },
      ephemeralPaths: ["__pycache__"], protectedPaths: [],
    });
    return null;
  },
};

const simpleDetectors: VerificationDetector[] = [
  {
    id: "go", async detect(root) { return await exists(root, "go.mod") ? recipe({
      profile: "go", toolchains: [{ executable: "go", versionArgs: ["version"] }], setup: [command("dependencies", ["go", "mod", "download"], { network: "enabled" })],
      gates: [command("test", ["go", "test", "./..."])], container: { image: "golang:1.24-bookworm" }, ephemeralPaths: [], protectedPaths: [],
    }) : null; },
  },
  {
    id: "rust", async detect(root) { return await exists(root, "Cargo.toml") && await exists(root, "Cargo.lock") ? recipe({
      profile: "rust-cargo", toolchains: [{ executable: "cargo", versionArgs: ["--version"] }], setup: [command("dependencies", ["cargo", "fetch", "--locked"], { network: "enabled" })],
      gates: [command("test", ["cargo", "test", "--locked"])], container: { image: "rust:1.87-bookworm" }, ephemeralPaths: ["target"], protectedPaths: [],
    }) : null; },
  },
  {
    id: "java", async detect(root) {
      if (await exists(root, "mvnw")) return recipe({ profile: "java-maven", toolchains: [{ executable: "./mvnw", versionArgs: ["--version"] }], setup: [], gates: [command("test", ["./mvnw", "--batch-mode", "test"], { network: "enabled" })], container: { image: "eclipse-temurin:21-jdk" }, ephemeralPaths: ["target"], protectedPaths: [] });
      if (await exists(root, "gradlew")) return recipe({ profile: "java-gradle", toolchains: [{ executable: "./gradlew", versionArgs: ["--version"] }], setup: [], gates: [command("test", ["./gradlew", "test"], { network: "enabled" })], container: { image: "eclipse-temurin:21-jdk" }, ephemeralPaths: [".gradle", "build"], protectedPaths: [] });
      return null;
    },
  },
  {
    id: "ruby", async detect(root) { return await exists(root, "Gemfile.lock") ? recipe({
      profile: "ruby-bundler", toolchains: [{ executable: "bundle", versionArgs: ["--version"] }], setup: [command("bundle-path", ["bundle", "config", "set", "path", ".veil-bundle"]), command("install", ["bundle", "install"], { network: "enabled" })],
      gates: [command("test", ["bundle", "exec", await isDirectory(root, "spec") ? "rspec" : "rake", ...(await isDirectory(root, "spec") ? [] : ["test"])])], container: { image: "ruby:3.4" },
      ephemeralPaths: [".bundle", ".veil-bundle"], protectedPaths: [],
    }) : null; },
  },
  {
    id: "php", async detect(root) { return await exists(root, "composer.lock") ? recipe({
      profile: "php-composer", toolchains: [{ executable: "composer", versionArgs: ["--version"] }], setup: [command("install", ["composer", "install", "--no-interaction"], { network: "enabled" })],
      gates: [command("test", ["vendor/bin/phpunit"])], container: { image: "composer:2" }, ephemeralPaths: ["vendor"], protectedPaths: [],
    }) : null; },
  },
  {
    id: "dotnet", async detect(root) {
      const entries = await readdir(root).catch(() => []);
      return entries.some((name) => /\.(?:sln|csproj|fsproj)$/i.test(name)) ? recipe({
        profile: "dotnet", toolchains: [{ executable: "dotnet", versionArgs: ["--version"] }], setup: [command("restore", ["dotnet", "restore"], { network: "enabled" })],
        gates: [command("test", ["dotnet", "test", "--no-restore"])], container: { image: "mcr.microsoft.com/dotnet/sdk:9.0" }, ephemeralPaths: ["bin", "obj"], protectedPaths: [],
      }) : null;
    },
  },
];

export const builtInVerificationDetectors: VerificationDetector[] = [nodeVerificationDetector, pythonVerificationDetector, ...simpleDetectors];

export async function detectVerificationRecipe(baseDirectory: string, detectors: VerificationDetector[] = builtInVerificationDetectors): Promise<VerificationRecipeV2 | null> {
  const configured = await text(baseDirectory, "veil.verify.json");
  if (configured !== null) {
    let decoded: unknown;
    try { decoded = JSON.parse(configured); } catch (error) { throw new Error(`veil.verify.json is invalid JSON: ${(error as Error).message}`); }
    const configuredRecipe = validateVerificationRecipe({ ...(decoded as object), source: "repository-config" });
    return validateVerificationRecipe({ ...configuredRecipe, protectedPaths: [...new Set(["veil.verify.json", ...configuredRecipe.protectedPaths])] });
  }
  const matches: Array<{ id: string; recipe: VerificationRecipeV2 }> = [];
  for (const detector of detectors) {
    const detected = await detector.detect(baseDirectory);
    if (detected) matches.push({ id: detector.id, recipe: detected });
  }
  if (matches.length > 1) throw new Error(`Multiple verification profiles were detected (${matches.map(({ id }) => id).join(", ")}); add veil.verify.json to choose explicit commands`);
  return matches[0]?.recipe ?? null;
}

export const createVerificationRecipe = detectVerificationRecipe;

/** Compatibility helper retained for integrations during the V2 migration. */
export async function createNodeVerificationPlan(candidateDirectory: string): Promise<VerificationRecipeV2> {
  const detected = await nodeVerificationDetector.detect(candidateDirectory);
  if (!detected) throw new Error("A supported Node lockfile and test script are required for the Node verification profile");
  return detected;
}

export function validateVerificationRecipe(input: unknown): VerificationRecipeV2 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Verification recipe must be an object");
  const value = input as Partial<VerificationRecipeV2>;
  if (value.version !== 2) throw new Error("Verification recipe version must be 2");
  if (!(["detected", "repository-config", "user-config"] as unknown[]).includes(value.source)) throw new Error("Verification recipe source is invalid");
  if (typeof value.profile !== "string" || !SAFE_NAME.test(value.profile)) throw new Error("Verification recipe profile is invalid");
  if (!Array.isArray(value.toolchains) || !Array.isArray(value.setup) || !Array.isArray(value.gates) || value.gates.length === 0) throw new Error("Verification recipe must include toolchains, setup, and at least one gate");
  if (!Array.isArray(value.ephemeralPaths) || !Array.isArray(value.protectedPaths)) throw new Error("Verification recipe paths are invalid");
  const toolchains = value.toolchains.map((toolchain) => {
    if (!toolchain || typeof toolchain.executable !== "string" || toolchain.executable.length === 0 || toolchain.executable.includes("\0") || !Array.isArray(toolchain.versionArgs) || toolchain.versionArgs.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Verification toolchain is invalid");
    return { executable: toolchain.executable, versionArgs: [...toolchain.versionArgs] };
  });
  const setup = value.setup.map((entry) => validateVerificationCommand(entry, "setup"));
  const gates = value.gates.map((entry) => validateVerificationCommand(entry, "gate"));
  const names = new Set<string>();
  for (const entry of [...setup, ...gates]) {
    if (names.has(entry.name)) throw new Error(`Duplicate verification command name: ${entry.name}`);
    names.add(entry.name);
  }
  const ephemeralPaths = value.ephemeralPaths.map((entry) => validateRelativePath(entry, "ephemeral"));
  const protectedPaths = value.protectedPaths.map((entry) => validateRelativePath(entry, "protected"));
  let container: VerificationRecipeV2["container"];
  if (value.container !== undefined) {
    if (!value.container || typeof value.container.image !== "string" || !SAFE_IMAGE.test(value.container.image) || (value.container.user !== undefined && (typeof value.container.user !== "string" || value.container.user.includes("\0")))) throw new Error("Verification container is invalid");
    container = { image: value.container.image, ...(value.container.user ? { user: value.container.user } : {}) };
  }
  return { version: 2, source: value.source!, profile: value.profile, toolchains, setup, gates, ...(container ? { container } : {}), ephemeralPaths, protectedPaths };
}

export function validateVerificationCommand(input: unknown, kind = "gate"): VerificationCommandSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`Verification ${kind} command is invalid`);
  const value = input as Partial<VerificationCommandSpec>;
  if (typeof value.name !== "string" || !SAFE_NAME.test(value.name)) throw new Error(`Verification ${kind} name is invalid`);
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.includes("\0"))) throw new Error(`Verification ${kind} argv is invalid`);
  if (/^(?:sh|bash|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)$/i.test(path.posix.basename(value.argv[0]!)) && value.argv.slice(1).some((arg) => arg === "-c" || arg === "-lc" || /^\/c$/i.test(arg))) {
    throw new Error(`Verification ${kind} must use an argument vector instead of an inline shell program`);
  }
  if (value.network !== "enabled" && value.network !== "disabled") throw new Error(`Verification ${kind} network policy is invalid`);
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs! < 1_000 || value.timeoutMs! > 60 * 60_000) throw new Error(`Verification ${kind} timeout is invalid`);
  if (typeof value.required !== "boolean") throw new Error(`Verification ${kind} required flag is invalid`);
  const environment = value.environment === undefined ? undefined : validateEnvironment(value.environment);
  return {
    name: value.name, argv: [...value.argv] as [string, ...string[]], network: value.network, timeoutMs: value.timeoutMs!, required: value.required,
    ...(value.workingDirectory ? { workingDirectory: validateRelativePath(value.workingDirectory, "working directory") } : {}),
    ...(environment ? { environment } : {}),
  };
}

function validateEnvironment(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Verification command environment is invalid");
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!SAFE_ENVIRONMENT_NAME.test(name) || typeof value !== "string" || value.includes("\0")) throw new Error("Verification command environment is invalid");
    if (/^(?:PATH|HOME|TMPDIR|LD_PRELOAD|NODE_OPTIONS|PYTHONPATH|RUBYOPT)$/i.test(name) || /(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(name)) throw new Error(`Verification command environment cannot override ${name}`);
    result[name] = value;
  }
  return result;
}

function validateRelativePath(input: unknown, label: string): string {
  if (typeof input !== "string" || !input || input.includes("\\") || path.posix.isAbsolute(input) || path.posix.normalize(input) !== input || input === ".." || input.startsWith("../")) throw new Error(`Verification ${label} path is invalid`);
  return input;
}

export function verificationRecipeDigest(recipe: VerificationRecipeV2): string {
  return createHash("sha256").update(JSON.stringify(validateVerificationRecipe(recipe))).digest("hex");
}

export function displayCommand(spec: Pick<VerificationCommandSpec, "argv">): string {
  return spec.argv.map((part) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(part) ? part : JSON.stringify(part)).join(" ");
}

/** @deprecated Kept for consumers that still need a shell rendering. */
export function shellCommand(command: string): string[] { return ["sh", "-lc", command]; }
