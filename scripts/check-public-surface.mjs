import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const denied = [
  ".agents", ".codex", ".playwright-cli", "AGENTS.md", "CODEX.md", "CONTEXT.md", "skills-lock.json",
  "apps", "extensions", "plugins", "infra", "supabase", "distribution", "spike", "output", "assets",
  "packages/bridge", "packages/identity", "packages/key-broker", "packages/object-store",
  "TUiDo", "api", "deploy", "express", "vercel.json", ".vercelignore",
  "codex-cli-audit-example", "veil-cli-audit-example", "veil-cli-audit-express", "veil-cli-audit-npm-ini",
  "veil-cli-audit-openai-python", "veil-cli-audit-setup-node", "veil-cli-audit-thread-stream",
  "veil-cli-final-flow", "veil-cli-preflight-diagnostic",
];
for (const target of denied) {
  try {
    await lstat(target);
    throw new Error(`Private surface present: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const markers = [
  "veil-private" + "-changes", "linear" + ".app/champv12workspace", "app" + ".notion.com",
  "PUBLIC_" + "DISTRIBUTION_TOKEN", "VSCE_" + "PAT", "OVSX_" + "PAT", "WORKOS_" + "API_KEY",
  "VEIL_BACKEND_" + "DATABASE_URL", "VEIL_LIFECYCLE_" + "DATABASE_URL", "/" + "Users/", "/private" + "/tmp",
  "Veil Proprietary" + " Software License", "SEE LICENSE" + " IN LICENSE",
];
for (const file of await walk(".")) {
  const content = await readFile(file);
  if (content.length > 2_000_000) throw new Error(`Public file exceeds size ceiling: ${file}`);
  if (content.includes(0)) throw new Error(`Unexpected binary file in public surface: ${file}`);
  const text = content.toString("utf8");
  if (text.includes("\uFFFD")) throw new Error(`Public text is not valid UTF-8: ${file}`);
  for (const marker of markers) if (text.includes(marker)) throw new Error(`Private marker in ${file}: ${marker}`);
}

async function walk(root) {
  const out = [];
  for (const name of await readdir(root, { withFileTypes: true })) {
    if (name.name === "node_modules" || name.name === ".git") continue;
    const file = path.join(root, name.name);
    if (name.isSymbolicLink()) throw new Error(`Public surface rejects symbolic links: ${file.replace(/^\.\//, "")}`);
    if (name.isDirectory()) out.push(...await walk(file));
    else if (name.isFile()) out.push(file);
    else throw new Error(`Public surface rejects special files: ${file.replace(/^\.\//, "")}`);
  }
  return out;
}
