import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeId } from "./util.js";

const MARKER = ".veil-run-root.json";

export interface SafeRunRoot {
  path: string;
  token: string;
}

/** Reopens a previously-created guarded root without trusting an arbitrary path. */
export async function readSafeRunRoot(rootPath: string, expectedToken: string): Promise<SafeRunRoot> {
  const resolved = path.resolve(rootPath);
  if (resolved === path.parse(resolved).root) throw new Error("Run root cannot be a filesystem root");
  const status = await lstat(resolved);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("Run root must be a real directory");
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error("Run root may not resolve through a symbolic link");
  const marker = JSON.parse(await readFile(path.join(canonical, MARKER), "utf8")) as { version?: unknown; runId?: unknown; token?: unknown };
  if (marker.version !== 1 || typeof marker.runId !== "string" || typeof marker.token !== "string" || marker.token !== expectedToken) {
    throw new Error("Run-root marker does not match");
  }
  assertSafeId(marker.runId);
  return { path: canonical, token: marker.token };
}

export async function createSafeRunRoot(parentDirectory: string, runId: string): Promise<SafeRunRoot> {
  assertSafeId(runId);
  const parent = path.resolve(parentDirectory);
  if (parent === path.parse(parent).root) throw new Error("Run parent cannot be a filesystem root");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(parent, `${runId}-`));
  const token = randomBytes(32).toString("hex");
  await writeFile(path.join(root, MARKER), JSON.stringify({ version: 1, runId, token }), { flag: "wx", mode: 0o600 });
  return { path: root, token };
}

export async function safeRemoveRunPath(target: string, runRoot: SafeRunRoot, allowRoot = false): Promise<void> {
  const root = path.resolve(runRoot.path);
  const resolvedTarget = path.resolve(target);
  if (root === path.parse(root).root) throw new Error("Refusing cleanup from filesystem root");
  const marker = JSON.parse(await readFile(path.join(root, MARKER), "utf8")) as { token?: unknown };
  if (marker.token !== runRoot.token) throw new Error("Run-root marker does not match");
  if (resolvedTarget === path.join(root, MARKER)) throw new Error("Refusing to remove the run-root marker");
  const isChild = resolvedTarget.startsWith(`${root}${path.sep}`);
  if (!isChild && !(allowRoot && resolvedTarget === root)) {
    throw new Error(`Refusing cleanup outside run root: ${resolvedTarget}`);
  }
  await rm(resolvedTarget, { recursive: true, force: true });
}
