import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateVerificationCommand } from "./plan.js";
import type { VerificationCommandSpec } from "./types.js";

const SUITE_VERSION = 2;
const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SAFE_GATE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_RELATIVE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Plaintext input accepted only by the trusted evaluator owner before sealing. */
export interface PrivateEvaluatorSuiteSource {
  gates: Array<{ redactedName: string; command: VerificationCommandSpec }>;
  files: Record<string, string>;
}

/** Encrypted at rest and safe to persist outside the candidate workspace. */
export interface EncryptedPrivateEvaluatorSuiteV2 {
  version: 2;
  algorithm: typeof ALGORITHM;
  ivBase64: string;
  ciphertextBase64: string;
  tagBase64: string;
  /** Only intentionally redacted labels are visible without decrypting. */
  gates: Array<{ redactedName: string }>;
}
export interface EncryptedPrivateEvaluatorSuiteV1 extends Omit<EncryptedPrivateEvaluatorSuiteV2, "version"> { version: 1 }
export type EncryptedPrivateEvaluatorSuite = EncryptedPrivateEvaluatorSuiteV1 | EncryptedPrivateEvaluatorSuiteV2;

export interface PrivateSuiteWorkspace {
  directory: string;
  gates: Array<{ redactedName: string; command: VerificationCommandSpec }>;
}

export function createPrivateEvaluatorSuite(input: {
  redactedName: string;
  command: VerificationCommandSpec;
  files: Record<string, string>;
}): PrivateEvaluatorSuiteSource {
  return { gates: [{ redactedName: input.redactedName, command: input.command }], files: input.files };
}

/** Compatibility adapter for the existing external Node security suite. */
export function createExternalNodeTestSuite(input: {
  redactedName: string;
  source: string;
  entrypoint?: string;
}): PrivateEvaluatorSuiteSource {
  const entrypoint = input.entrypoint ?? "security.test.mjs";
  return createPrivateEvaluatorSuite({
    redactedName: input.redactedName,
    command: {
      name: input.redactedName,
      argv: ["node", "--test", `{{privateSuite}}/${entrypoint}`],
      environment: { CANDIDATE_ROOT: "{{candidateRoot}}" },
      network: "disabled",
      timeoutMs: 5 * 60_000,
      required: true,
    },
    files: { [entrypoint]: input.source },
  });
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error("Private evaluator key must be exactly 32 bytes");
}

function validateSource(source: PrivateEvaluatorSuiteSource): PrivateEvaluatorSuiteSource {
  if (!source || !Array.isArray(source.gates) || source.gates.length === 0 || typeof source.files !== "object" || source.files === null) {
    throw new Error("Private evaluator suite must include gates and files");
  }
  const names = new Set<string>();
  const gates = source.gates.map((gate) => {
    if (!SAFE_GATE_NAME.test(gate.redactedName) || names.has(gate.redactedName)) throw new Error("Private evaluator gate name is invalid");
    names.add(gate.redactedName);
    return { redactedName: gate.redactedName, command: validateVerificationCommand(gate.command, "private gate") };
  });
  const files: Record<string, string> = {};
  for (const [relativePath, contents] of Object.entries(source.files)) {
    if (!SAFE_RELATIVE_PATH.test(relativePath) || typeof contents !== "string") throw new Error("Private evaluator file is invalid");
    files[relativePath] = contents;
  }
  return { gates, files };
}

export function sealPrivateEvaluatorSuite(source: PrivateEvaluatorSuiteSource, key: Buffer): EncryptedPrivateEvaluatorSuiteV2 {
  assertKey(key);
  const validated = validateSource(source);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify({ version: SUITE_VERSION, ...validated }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: SUITE_VERSION,
    algorithm: ALGORITHM,
    ivBase64: iv.toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    tagBase64: cipher.getAuthTag().toString("base64"),
    gates: validated.gates.map(({ redactedName }) => ({ redactedName })),
  };
}

function openPrivateEvaluatorSuite(envelope: EncryptedPrivateEvaluatorSuite, key: Buffer): PrivateEvaluatorSuiteSource {
  assertKey(key);
  if (!envelope || (envelope.version !== 1 && envelope.version !== SUITE_VERSION) || envelope.algorithm !== ALGORITHM || !Array.isArray(envelope.gates)) throw new Error("Unsupported private evaluator suite envelope");
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.ivBase64, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tagBase64, "base64"));
    const decoded = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertextBase64, "base64")), decipher.final(),
    ]).toString("utf8")) as (PrivateEvaluatorSuiteSource & { version?: number }) | { version?: number; gates: Array<{ redactedName: string; entrypoint: string }>; files: Record<string, string> };
    let validated: PrivateEvaluatorSuiteSource;
    if (envelope.version === 1 && decoded.version === 1) {
      const legacy = decoded as { gates: Array<{ redactedName: string; entrypoint: string }>; files: Record<string, string> };
      validated = validateSource({
        files: legacy.files,
        gates: legacy.gates.map(({ redactedName, entrypoint }) => ({
          redactedName,
          command: { name: redactedName, argv: ["node", "--test", `{{privateSuite}}/${entrypoint}`], environment: { CANDIDATE_ROOT: "{{candidateRoot}}" }, network: "disabled", timeoutMs: 5 * 60_000, required: true },
        })),
      });
    } else {
      if (decoded.version !== SUITE_VERSION) throw new Error("Unsupported private evaluator suite version");
      validated = validateSource(decoded as PrivateEvaluatorSuiteSource);
    }
    if (JSON.stringify(validated.gates.map(({ redactedName }) => ({ redactedName }))) !== JSON.stringify(envelope.gates)) throw new Error("Private evaluator gate manifest mismatch");
    return validated;
  } catch { throw new Error("Private evaluator suite could not be opened"); }
}

/** Materialize only inside an evaluator-controlled temporary directory. */
export async function materializePrivateEvaluatorSuite(options: {
  envelope: EncryptedPrivateEvaluatorSuite;
  key: Buffer;
  directory: string;
}): Promise<PrivateSuiteWorkspace> {
  const source = openPrivateEvaluatorSuite(options.envelope, options.key);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  try {
    for (const [relativePath, contents] of Object.entries(source.files)) {
      const target = path.join(options.directory, relativePath);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  } catch (error) {
    await rm(options.directory, { recursive: true, force: true });
    throw error;
  }
  return { directory: options.directory, gates: source.gates };
}
