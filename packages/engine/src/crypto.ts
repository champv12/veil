import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertCapabilities, type Capability } from "@veil/contracts";
import { assertSafeId, canonicalJson } from "./util.js";

const GRANT_INFO = Buffer.from("veil-grant-v1", "utf8");
const OBJECT_KEY_INFO = Buffer.from("veil-object-encryption-v1", "utf8");
const ADDRESS_KEY_INFO = Buffer.from("veil-private-address-v1", "utf8");
export const MAX_AGENT_GRANT_TTL_MS = 30 * 60 * 1_000;

export interface Identity {
  id: string;
  publicKeyPem: string;
  privateKeyPath: string;
  persistent: boolean;
  createdAt: string;
}

export interface GrantEnvelope {
  version: 1;
  changeId: string;
  recipientIdentityId: string;
  capabilities: Capability[];
  expiresAt: string;
  ephemeralPublicKey: string;
  salt: string;
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}

export type EncryptedObjectType = "file" | "manifest" | "evidence";

export interface EncryptedObjectEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  changeId: string;
  objectId: string;
  objectType: EncryptedObjectType;
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}

function deriveKey(input: Buffer, salt: Buffer, info: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", input, salt, info, 32));
}

function fromBase64(value: string, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid base64 encoding");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new Error("Invalid base64 encoding");
  }
  return decoded;
}

function grantAad(grant: Pick<GrantEnvelope, "version" | "changeId" | "recipientIdentityId" | "capabilities" | "expiresAt">): Buffer {
  return Buffer.from(canonicalJson({
    version: grant.version,
    changeId: grant.changeId,
    recipientIdentityId: grant.recipientIdentityId,
    capabilities: grant.capabilities,
    expiresAt: grant.expiresAt,
  }), "utf8");
}

export class IdentityStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async createOrLoadMaintainer(id = "maintainer"): Promise<Identity> {
    assertSafeId(id);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const metadataPath = path.join(this.root, `${id}.identity.json`);
    let rawMetadata: string;
    try {
      rawMetadata = await readFile(metadataPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.#create(this.root, id, true, metadataPath);
      }
      throw error;
    }
    const identity = JSON.parse(rawMetadata) as Identity;
    const expectedPrivateKeyPath = path.join(this.root, `${id}.pk8.pem`);
    let storedPrivateKeyPath: string;
    let canonicalExpectedPath: string;
    try {
      [storedPrivateKeyPath, canonicalExpectedPath] = await Promise.all([realpath(identity.privateKeyPath), realpath(expectedPrivateKeyPath)]);
    } catch {
      throw new Error(`Invalid persisted identity metadata for ${id}`);
    }
    if (identity.id !== id || !identity.persistent || storedPrivateKeyPath !== canonicalExpectedPath) {
      throw new Error(`Invalid persisted identity metadata for ${id}`);
    }
    const privateStat = await lstat(identity.privateKeyPath);
    if (!privateStat.isFile() || privateStat.isSymbolicLink()) throw new Error(`Invalid persisted identity metadata for ${id}`);
    if ((privateStat.mode & 0o077) !== 0) await chmod(identity.privateKeyPath, 0o600);
    return identity;
  }

  async createEphemeral(runKeyRoot: string, id: string): Promise<Identity> {
    assertSafeId(id);
    const resolved = path.resolve(runKeyRoot);
    return this.#create(resolved, id, false);
  }

  async #create(directory: string, id: string, persistent: boolean, metadataPath?: string): Promise<Identity> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const privateKeyPath = path.join(directory, `${id}.pk8.pem`);
    const identity: Identity = {
      id,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPath,
      persistent,
      createdAt: new Date().toISOString(),
    };
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    await chmod(privateKeyPath, 0o600);
    if (metadataPath) {
      await writeFile(metadataPath, `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    return identity;
  }
}

export function createWorkspaceMasterKey(): Buffer {
  return randomBytes(32);
}

export function createCapabilityGrant(options: {
  changeId: string;
  workspaceMasterKey: Buffer;
  recipient: Pick<Identity, "id" | "publicKeyPem">;
  capabilities: Capability[];
  expiresAt: Date;
}): GrantEnvelope {
  assertSafeId(options.changeId);
  assertSafeId(options.recipient.id);
  assertCapabilities(options.capabilities);
  if (options.workspaceMasterKey.length !== 32) throw new Error("Workspace master key must be 256 bits");
  if (!Number.isFinite(options.expiresAt.getTime())) throw new Error("Grant expiry is invalid");
  const capabilities = [...new Set(options.capabilities)].sort();
  const { publicKey: ephemeralPublicKey, privateKey: ephemeralPrivateKey } = generateKeyPairSync("x25519");
  const sharedSecret = diffieHellman({
    privateKey: ephemeralPrivateKey,
    publicKey: createPublicKey(options.recipient.publicKeyPem),
  });
  const salt = randomBytes(32);
  const wrappingKey = deriveKey(sharedSecret, salt, GRANT_INFO);
  const nonce = randomBytes(12);
  const authenticated = {
    version: 1 as const,
    changeId: options.changeId,
    recipientIdentityId: options.recipient.id,
    capabilities,
    expiresAt: options.expiresAt.toISOString(),
  };
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce);
  cipher.setAAD(grantAad(authenticated));
  const ciphertext = Buffer.concat([cipher.update(options.workspaceMasterKey), cipher.final()]);
  return {
    ...authenticated,
    ephemeralPublicKey: ephemeralPublicKey.export({ type: "spki", format: "der" }).toString("base64"),
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
  };
}

export function createAgentGrant(options: Omit<Parameters<typeof createCapabilityGrant>[0], "expiresAt"> & { now?: Date; ttlMs?: number }): GrantEnvelope {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? MAX_AGENT_GRANT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_AGENT_GRANT_TTL_MS) {
    throw new Error("Agent grant TTL must be positive and no longer than 30 minutes");
  }
  return createCapabilityGrant({
    changeId: options.changeId,
    workspaceMasterKey: options.workspaceMasterKey,
    recipient: options.recipient,
    capabilities: options.capabilities,
    expiresAt: new Date(now.getTime() + ttlMs),
  });
}

export async function unwrapGrant(
  grant: GrantEnvelope,
  identity: Pick<Identity, "id" | "privateKeyPath">,
  requiredCapability: Capability,
  now = new Date(),
): Promise<Buffer> {
  if (grant.version !== 1) throw new Error("Unsupported grant version");
  assertSafeId(grant.changeId);
  assertSafeId(grant.recipientIdentityId);
  assertCapabilities(grant.capabilities);
  if (grant.recipientIdentityId !== identity.id) throw new Error("Grant recipient does not match identity");
  if (!grant.capabilities.includes(requiredCapability)) throw new Error(`Grant lacks required capability: ${requiredCapability}`);
  if (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now.getTime()) throw new Error("Grant has expired");
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey(await readFile(identity.privateKeyPath, "utf8")),
    publicKey: createPublicKey({ key: fromBase64(grant.ephemeralPublicKey), type: "spki", format: "der" }),
  });
  const wrappingKey = deriveKey(sharedSecret, fromBase64(grant.salt, 32), GRANT_INFO);
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, fromBase64(grant.nonce, 12));
  decipher.setAAD(grantAad(grant));
  decipher.setAuthTag(fromBase64(grant.authenticationTag, 16));
  const plaintext = Buffer.concat([decipher.update(fromBase64(grant.ciphertext, 32)), decipher.final()]);
  if (plaintext.length !== 32) throw new Error("Invalid wrapped workspace key");
  return plaintext;
}

function objectKeys(masterKey: Buffer, changeId: string): { encryptionKey: Buffer; addressKey: Buffer } {
  const salt = Buffer.from(changeId, "utf8");
  return {
    encryptionKey: deriveKey(masterKey, salt, OBJECT_KEY_INFO),
    addressKey: deriveKey(masterKey, salt, ADDRESS_KEY_INFO),
  };
}

function objectAad(changeId: string, objectId: string, objectType: EncryptedObjectType): Buffer {
  return Buffer.from(canonicalJson({ version: 1, changeId, objectId, objectType }), "utf8");
}

export function encryptObject(masterKey: Buffer, changeId: string, objectType: EncryptedObjectType, plaintext: Buffer): EncryptedObjectEnvelope {
  if (masterKey.length !== 32) throw new Error("Workspace master key must be 256 bits");
  const { encryptionKey, addressKey } = objectKeys(masterKey, changeId);
  const objectId = createHmac("sha256", addressKey).update(objectType).update("\0").update(plaintext).digest("hex");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(objectAad(changeId, objectId, objectType));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    changeId,
    objectId,
    objectType,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptObject(masterKey: Buffer, envelope: EncryptedObjectEnvelope, expectedType: EncryptedObjectType): Buffer {
  if (masterKey.length !== 32) throw new Error("Workspace master key must be 256 bits");
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("Unsupported encrypted object envelope");
  assertSafeId(envelope.changeId);
  if (!/^[a-f0-9]{64}$/.test(envelope.objectId)) throw new Error("Invalid object identifier");
  if (envelope.objectType !== expectedType) throw new Error(`Unexpected object type: ${envelope.objectType}`);
  const { encryptionKey, addressKey } = objectKeys(masterKey, envelope.changeId);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, fromBase64(envelope.nonce, 12));
  decipher.setAAD(objectAad(envelope.changeId, envelope.objectId, envelope.objectType));
  decipher.setAuthTag(fromBase64(envelope.authenticationTag, 16));
  const plaintext = Buffer.concat([decipher.update(fromBase64(envelope.ciphertext)), decipher.final()]);
  const actualId = createHmac("sha256", addressKey).update(envelope.objectType).update("\0").update(plaintext).digest("hex");
  if (actualId !== envelope.objectId) throw new Error("Object address verification failed");
  return plaintext;
}
