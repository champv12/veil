import { createHash, randomUUID } from "node:crypto";
import { link, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Value cannot be encoded as JSON");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Unsupported JSON value: ${typeof value}`);
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error(`Unsafe identifier: ${JSON.stringify(id)}`);
  }
}

export function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0") ||
    relativePath.split(/[\\/]/).some((component) => component === "" || component === ".." || component === ".")
  ) {
    throw new Error(`Unsafe relative path: ${JSON.stringify(relativePath)}`);
  }
}

export function resolveWithin(root: string, relativePath: string): string {
  assertSafeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes root: ${JSON.stringify(relativePath)}`);
  }
  return resolved;
}

/**
 * Commit one small metadata file durably. The temporary file is flushed before
 * it is linked/renamed into place and the containing directory is flushed
 * afterwards, so a successful call survives a host crash on supported local
 * filesystems.
 */
export async function durableWriteFile(
  target: string,
  data: string | Buffer,
  options: { mode?: number; replace?: boolean } = {},
): Promise<void> {
  const temporary = `${target}.${newId("tmp")}`;
  const handle = await open(temporary, "wx", options.mode ?? 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    if (options.replace) await rename(temporary, target);
    else {
      await link(temporary, target);
      await unlink(temporary);
    }
    const directory = await open(path.dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
