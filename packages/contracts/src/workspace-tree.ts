import { createHash } from "node:crypto";
import { ContractValidationError, isRecord } from "./validation.js";

export interface WorkspaceTreeFileEntry {
  path: string;
  kind: "file";
  executable: boolean;
  size: number;
  contentSha256: string;
}

export interface WorkspaceTreeManifest {
  version: 1;
  hashAlgorithm: "sha256";
  entries: WorkspaceTreeFileEntry[];
}

export interface WorkspaceTreeIdentity {
  id: `sha256:${string}`;
  manifest: WorkspaceTreeManifest;
}

export function identifyWorkspaceTree(value: unknown): WorkspaceTreeIdentity {
  if (!isRecord(value)) {
    throw new ContractValidationError(["workspace tree manifest is invalid"]);
  }
  const unknownManifestFields = unknownFields(value, ["version", "hashAlgorithm", "entries"]);
  if (unknownManifestFields.length > 0) {
    throw new ContractValidationError([
      `workspace tree manifest contains unknown fields: ${unknownManifestFields.join(", ")}`,
    ]);
  }
  if (value.version !== 1) {
    throw new ContractValidationError(["workspace tree manifest version is unsupported"]);
  }
  if (value.hashAlgorithm !== "sha256") {
    throw new ContractValidationError(["workspace tree manifest hash algorithm is unsupported"]);
  }
  if (!Array.isArray(value.entries)) {
    throw new ContractValidationError(["workspace tree manifest entries must be an array"]);
  }

  const entries = value.entries.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ContractValidationError([`workspace tree entries[${index}] must be an object`]);
    }
    const unknownEntryFields = unknownFields(entry, [
      "path",
      "kind",
      "executable",
      "size",
      "contentSha256",
    ]);
    if (unknownEntryFields.length > 0) {
      throw new ContractValidationError([
        `workspace tree entries[${index}] contains unknown fields: ${unknownEntryFields.join(", ")}`,
      ]);
    }
    if (typeof entry.path !== "string" || !isSafeWorkspacePath(entry.path)) {
      throw new ContractValidationError([`workspace tree entries[${index}].path is unsafe`]);
    }
    if (entry.kind !== "file") {
      throw new ContractValidationError([`workspace tree entries[${index}].kind is unsupported`]);
    }
    if (typeof entry.executable !== "boolean") {
      throw new ContractValidationError([`workspace tree entries[${index}].executable must be boolean`]);
    }
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
      throw new ContractValidationError([
        `workspace tree entries[${index}].size must be a non-negative safe integer`,
      ]);
    }
    if (typeof entry.contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.contentSha256)) {
      throw new ContractValidationError([
        `workspace tree entries[${index}].contentSha256 must be a lowercase SHA-256 digest`,
      ]);
    }
    return {
      path: entry.path,
      kind: entry.kind,
      executable: entry.executable,
      size: entry.size as number,
      contentSha256: entry.contentSha256,
    } satisfies WorkspaceTreeFileEntry;
  }).sort((left, right) => compareOrdinal(left.path, right.path));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]?.path === entries[index]?.path) {
      throw new ContractValidationError([
        `workspace tree entries contain duplicate path: ${entries[index]?.path}`,
      ]);
    }
  }

  const manifest: WorkspaceTreeManifest = {
    version: 1,
    hashAlgorithm: "sha256",
    entries,
  };
  const digest = createHash("sha256").update(canonicalJson(manifest), "utf8").digest("hex");
  return { id: `sha256:${digest}`, manifest };
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isSafeWorkspacePath(value: string): boolean {
  if (value.length === 0
    || value.includes("\0")
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)) {
    return false;
  }

  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function unknownFields(value: Record<string, unknown>, allowed: string[]): string[] {
  const allowedFields = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedFields.has(key)).sort();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContractValidationError(["workspace tree contains a non-finite number"]);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new ContractValidationError(["workspace tree contains a non-JSON value"]);
}
