# Veil V1 architecture

Veil treats an encrypted private change—not a repository, branch, or commit—as the primary unit. Git is used only to import an immutable public base and export an explicitly approved result.

```text
React/Vite UI
    │ HTTP + SSE
Fastify control plane
    │
Local execution backend
    ├── encrypted control-plane records
    ├── identity and capability-grant store
    ├── encrypted immutable snapshot store
    ├── Codex execution-view runner
    ├── isolated local evaluator
    ├── Git import/publication adapter
    └── hash-backed evidence service
```

## Storage separation

`.veil-state/product/control-plane/records/` contains AES-256-GCM encrypted API records. `.veil-state/product/runtime/engine/encrypted-store/` contains encrypted file, manifest, and evidence objects. Persistent maintainer private keys and the control-plane storage key live beneath private directories with `0600` file permissions.

Plaintext repository views exist only beneath validated run roots. They are never placed in the encrypted object store, Git repository, or API response. Cleanup validates a random run-root marker before recursive deletion. The V1 Codex CLI sandbox is not a mount namespace: it prevents workspace network access and limits writes, but it does not establish a proven read-deny boundary around sibling local state.

## Private-change creation

1. The Git adapter clones and resolves the requested public ref.
2. The engine creates or loads the maintainer X25519 identity.
3. It creates a random 256-bit workspace master key.
4. The master key is wrapped for the maintainer using ephemeral X25519, HKDF-SHA256, and AES-256-GCM.
5. The repository tree is captured as encrypted objects and an encrypted manifest.
6. The plaintext import view is destroyed.

## Agent execution

When the user chooses the bundled Codex harness, it receives a new ephemeral X25519 identity and a 30-minute read/modify grant. The orchestrator unwraps the key outside the agent process, deletes the ephemeral private-key file before Codex starts, materializes a `.git`-free execution view, writes the private brief at `.veil-private/brief.md`, and launches `codex exec` with a minimal environment. No Veil key is deliberately passed through arguments or environment variables; hardened mount isolation is deferred.

File-change events trigger best-effort intermediate encrypted snapshots; because the live filesystem can continue changing, only the post-exit final snapshot is authoritative. The final trace is encrypted as evidence, the final result is captured, and the disposable execution view and ephemeral private key are destroyed before evaluation. Manual edits and agent-assisted edits follow the same linear snapshot history.

## Evaluation

When a verification recipe is configured, the captured result is materialized again from its encrypted snapshot. The evaluator copies a sanitized view into a fresh temporary directory, runs recipe setup with its declared network policy, and then runs required recipe gates with networking denied by default. Without a recipe, Veil reports the result as `unchecked` and does not claim repository tests ran.

On macOS, Veil uses the built-in Seatbelt sandbox. On Linux, it uses a Bubblewrap mount and network namespace. Both exclude the host home, SSH configuration, OpenAI credentials, Git credentials, Veil keys, and sibling workspaces. Docker is supported only as an optional fallback when a native verifier is unavailable.

## Publication

The Git adapter removes private paths, scans the full sanitized tree for confidential brief fragments, generates a binary-safe patch, and verifies it applies to the recorded base. A fresh isolated evaluation must pass again. Only then can an explicit API confirmation produce either:

- a patch artifact with no remote mutation, or
- a dedicated `veil/*` branch and optional draft GitHub pull request.

The current snapshot ID, base commit, patch SHA-256, public commit, and draft PR URL form the publication receipt.
