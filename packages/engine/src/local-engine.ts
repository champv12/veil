import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BaseReference, PrivateChange } from "@veil/contracts";
import { IdentityStore } from "./crypto.js";
import { JsonEventStore } from "./event-store.js";
import { EncryptedSnapshotStore } from "./snapshot.js";
import { DurableManualWorkspaceRegistry } from "./manual-workspace-registry.js";

export class LocalVeilEngine {
  readonly root: string;
  readonly events: JsonEventStore;
  readonly snapshots: EncryptedSnapshotStore;
  readonly identities: IdentityStore;
  readonly runsDirectory: string;
  readonly manualWorkspaces: DurableManualWorkspaceRegistry;

  private constructor(root: string) {
    this.root = root;
    this.events = new JsonEventStore(path.join(root, "metadata"));
    this.snapshots = new EncryptedSnapshotStore(path.join(root, "encrypted-store"), this.events);
    this.identities = new IdentityStore(path.join(root, "private", "identities"));
    this.runsDirectory = path.join(root, "private", "runs");
    this.manualWorkspaces = new DurableManualWorkspaceRegistry(path.join(root, "manual-workspaces"));
  }

  static async open(root: string): Promise<LocalVeilEngine> {
    const engine = new LocalVeilEngine(path.resolve(root));
    await Promise.all([
      engine.events.initialize(),
      engine.snapshots.initialize(),
      engine.manualWorkspaces.initialize(),
      mkdir(engine.runsDirectory, { recursive: true, mode: 0o700 }),
    ]);
    return engine;
  }

  async createPrivateChange(input: {
    title: string;
    description: string;
    base: BaseReference;
    ownerIdentityId?: string;
  }): Promise<PrivateChange> {
    const maintainer = await this.identities.createOrLoadMaintainer(input.ownerIdentityId ?? "maintainer");
    const change = await this.events.createChange({
      title: input.title,
      description: input.description,
      base: input.base,
      ownerIdentityId: maintainer.id,
    });
    await this.events.appendAudit(change.id, "identity.created", maintainer.id, {
      identityId: maintainer.id,
      persistent: true,
    });
    return change;
  }
}
