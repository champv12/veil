import { readFile } from "node:fs/promises";
import { thirdPartyNotices } from "./license-notices.mjs";

const workspaceNames = ["agent-runner", "contracts", "engine", "evaluator", "evidence", "git-adapter"];
const paths = ["package.json", ...workspaceNames.map((name) => `packages/${name}/package.json`)];
const manifests = new Map();
for (const file of paths) {
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value.license !== "MIT") throw new Error(`MIT license missing: ${file}`);
  manifests.set(file === "package.json" ? "" : file.slice(0, -"/package.json".length), value);
}
if (!(await readFile("LICENSE", "utf8")).startsWith("MIT License\n")) throw new Error("Canonical MIT license missing");

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") throw new Error("Public package-lock must use lockfileVersion 3");
const expectedWorkspaces = workspaceNames.map((name) => `packages/${name}`);
if (!equal(lock.packages[""]?.workspaces, manifests.get("").workspaces)) throw new Error("Public package-lock workspace declaration is inconsistent");
for (const [workspacePath, manifest] of manifests) {
  const entry = lock.packages[workspacePath];
  if (!entry) throw new Error(`Public package-lock is missing ${workspacePath || "root"}`);
  for (const field of ["name", "version", "license", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines", "bin", "os", "cpu"]) {
    if (!equal(entry[field], manifest[field])) throw new Error(`Public package-lock ${workspacePath || "root"} disagrees on ${field}`);
  }
  if (!workspacePath) continue;
  const link = lock.packages[`node_modules/${manifest.name}`];
  if (!link || link.link !== true || link.resolved !== workspacePath) throw new Error(`Public package-lock workspace link is invalid: ${manifest.name}`);
}
const workspacePaths = new Set(["", ...expectedWorkspaces]);
for (const [packagePath, entry] of Object.entries(lock.packages)) {
  if (workspacePaths.has(packagePath) || entry.link) continue;
  if (!packagePath.includes("node_modules/")) throw new Error(`Unexpected package-lock surface: ${packagePath}`);
  if (typeof entry.version !== "string" || typeof entry.license !== "string" || !entry.license) throw new Error(`Third-party lock metadata incomplete: ${packagePath}`);
}

const expectedNotices = thirdPartyNotices(lock);
if ((await readFile("THIRD_PARTY_NOTICES.md", "utf8")) !== expectedNotices) throw new Error("THIRD_PARTY_NOTICES.md is out of sync with package-lock.json");

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
