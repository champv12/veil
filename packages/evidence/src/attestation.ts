import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertExactResultAttestationPayload,
  assertSignedExactResultAttestation,
  type ExactResultAttestationPayload,
  type SignedExactResultAttestation,
} from "@veil/contracts";
import { canonicalJson } from "./report.js";

export type AttestationPrivateKey = KeyObject | string | Buffer;
export type AttestationPublicKey = KeyObject | string | Buffer;

function payloadBytes(payload: ExactResultAttestationPayload): Buffer {
  return Buffer.from(canonicalJson(payload), "utf8");
}

function privateKey(value: AttestationPrivateKey): KeyObject {
  const key = value instanceof KeyObject ? value : createPrivateKey(value);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new Error("Attestation signing key must be an Ed25519 private key");
  return key;
}

function publicKey(value: AttestationPublicKey): KeyObject {
  let key = value instanceof KeyObject ? value : createPublicKey(value);
  if (key.type === "private") key = createPublicKey(key);
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("Attestation verification key must be an Ed25519 public key");
  return key;
}

export function signExactResultAttestation(
  payload: ExactResultAttestationPayload,
  options: { keyId: string; privateKey: AttestationPrivateKey; now?: Date },
): SignedExactResultAttestation {
  assertExactResultAttestationPayload(payload);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(options.keyId)) throw new Error("Attestation key ID is invalid");
  const now = options.now ?? new Date();
  if (Date.parse(payload.issuedAt) > now.getTime() + 60_000) throw new Error("Attestation issuance time is in the future");
  if (Date.parse(payload.publicationIntent.expiresAt) <= now.getTime()) throw new Error("Cannot sign an expired publication intent");
  if (Date.parse(payload.publicationIntent.expiresAt) <= Date.parse(payload.issuedAt)) throw new Error("Publication intent must expire after attestation issuance");
  const bytes = payloadBytes(payload);
  return {
    version: 1,
    algorithm: "Ed25519",
    keyId: options.keyId,
    payloadSha256: createHash("sha256").update(bytes).digest("hex"),
    payload: structuredClone(payload),
    signature: sign(null, bytes, privateKey(options.privateKey)).toString("base64"),
  };
}

export function verifyExactResultAttestation(
  attestation: SignedExactResultAttestation,
  verificationKey: AttestationPublicKey,
  options: { now?: Date; allowExpired?: boolean } = {},
): boolean {
  try { assertSignedExactResultAttestation(attestation); } catch { return false; }
  const bytes = payloadBytes(attestation.payload);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== attestation.payloadSha256) return false;
  const receipt = attestation.payload.publicationReceipt;
  if (receipt) {
    if (Date.parse(receipt.publishedAt) > Date.parse(attestation.payload.publicationIntent.expiresAt)) return false;
  } else if (!options.allowExpired && Date.parse(attestation.payload.publicationIntent.expiresAt) <= (options.now ?? new Date()).getTime()) return false;
  try {
    const key = publicKey(verificationKey);
    if (attestation.keyId.startsWith("local:")) {
      const expectedKeyId = `local:${createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex")}`;
      if (attestation.keyId !== expectedKeyId) return false;
    }
    return verify(null, bytes, key, Buffer.from(attestation.signature, "base64"));
  }
  catch { return false; }
}

export async function writeExactResultAttestation(directory: string, attestation: SignedExactResultAttestation): Promise<string> {
  assertSignedExactResultAttestation(attestation);
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(attestation.payload.attestationId)) throw new Error("Unsafe attestation identifier");
  const target = path.join(root, `${attestation.payload.attestationId}.attestation.json`);
  await writeFile(target, `${JSON.stringify(attestation, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return target;
}
