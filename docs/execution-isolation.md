# Mount-isolated Codex execution

`@veil/agent-runner` preserves Codex-owned authentication: Veil never reads, copies, or mounts `auth.json`. Consequently, `isolationMode: "required"` currently fails closed rather than weakening the credential boundary by putting Codex credentials in a bubblewrap namespace. The local macOS/Linux V1 flow runs with `isolationMode: "disabled"`; it must not claim mount isolation.

The planned execution namespace will have a tmpfs root and mount only:

- the validated, materialized agent workspace at `/workspace` (the sole writable host mount);
- a runner-created `/run` directory containing the output schema and last-message output;
- the Codex executable and a small read-only operating-system runtime (`/usr`, `/bin`, `/lib`, `/lib64`), plus synthetic `/proc` and `/dev`.

The planned boundary does not mount the host root or home, the Veil run root, key directories, snapshot mappings, publisher/Git credentials, Docker sockets, or sibling agent workspaces. Commands that Codex launches inside the workspace remain network-disabled through `sandbox_workspace_write.network_access=false`; the mount boundary exposes no host network credential or socket.

Before any future mount, the runner will walk the workspace and reject symbolic links and special files. That validation already runs, but `isolationMode: "required"` currently fails before bubblewrap starts because Codex-owned credentials are not copied or mounted. Disabled mode runs Codex directly with the documented process and environment restrictions; it is not a namespace boundary. The planned bubblewrap mode will start a new session/process group, request `--die-with-parent`, send TERM then KILL on cancellation or timeout, and remove its temporary output root in `finally`. Codex authentication remains in Codex's user-owned credential store and will never become part of that root.

## Claim boundaries

The mount plan remains a future namespace and mount-isolation design, but it is not an active execution mode until an OS-native credential boundary can let the trusted Codex process authenticate without copying or mounting credentials. Disabled mode is the existing local development boundary and does not satisfy CHA-35. Neither mode protects against a compromised kernel, root, container runtime, or the authorized model provider. The read-only runtime is deliberately minimal but is still trusted executable code.

Cleanup is **logical cleanup**: the temporary directory is removed from the live filesystem namespace after descendants have been terminated. It is not forensic erasure; bytes may persist in filesystem journals, snapshots, swap, backups, crash dumps, or storage media. Operators needing forensic destruction must use encrypted ephemeral volumes and destroy their encryption keys separately.
