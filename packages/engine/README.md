# Engine plaintext editing boundary

`ManualSnapshotViewManager` materializes one authorized encrypted snapshot into a
short-lived, `.git`-free plaintext directory. The engine returns only editor
launch descriptors (VS Code, Cursor, terminal, or copy-path); it does not
execute shell commands or pass environment variables to an editor.

The host must supply `authorizeSnapshot`, which is where tenant and user access
control belongs. The engine independently verifies the requested change and the
entire snapshot parent lineage. Known credential-bearing paths (`.env`, `.aws`,
`.ssh`, keys, and credentials files) are rejected before materialization.

The plaintext directory contains no Veil, WorkOS, OpenAI, GitHub, AWS, or
publication capability supplied by this API. Hosts should launch editors with a
sanitized environment and must call `destroy()` in a `finally` block. Captures
are immutable `manual` child snapshots of the selected source snapshot.
