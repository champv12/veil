# Verification recipes

Repository admission is language-neutral. Veil opens any safe public GitHub
URL or clean local GitHub checkout—including an already-authenticated private
checkout—then independently determines whether it can verify that repository's
results.

Veil detects common Node, Python, Go, Rust, Java/Kotlin, Ruby, PHP, and .NET
layouts. For another ecosystem—or to override ambiguous detection—commit a
`veil.verify.json` file at the repository root.

```json
{
  "version": 2,
  "source": "repository-config",
  "profile": "zig-project",
  "toolchains": [
    { "executable": "zig", "versionArgs": ["version"] }
  ],
  "setup": [],
  "gates": [
    {
      "name": "test",
      "argv": ["zig", "build", "test"],
      "network": "disabled",
      "timeoutMs": 300000,
      "required": true
    }
  ],
  "ephemeralPaths": [".zig-cache", "zig-out"],
  "protectedPaths": []
}
```

Commands are argument vectors, not shell programs. Inline `sh -c`, path
traversal, unsafe environment overrides, duplicate gate names, malformed
container images, and invalid timeouts are rejected. Setup commands may opt into
networking; verification gates should remain network-disabled unless the check
fundamentally requires otherwise.

Recipes are read from the immutable base commit and pinned by digest before
private work begins. Editing `veil.verify.json` in a candidate cannot change the
commands used to evaluate that candidate or its fresh publication check.

## Statuses

- `ready` / `verified`: the recipe, toolchain, sandbox, baseline, and candidate
  gates passed.
- `unchecked`: no recipe was detected or configured. Work, capture, review, and
  patch export remain available, but Veil does not claim repository tests ran.
- `unavailable`: a recipe exists but is invalid or its required toolchain is
  missing.
- `baseline-failed`: the immutable base did not pass its recipe.
- `sandbox-unavailable`: Veil could not establish macOS, Bubblewrap, or optional
  Docker isolation.

Unchecked draft pull requests require `--allow-unchecked` in addition to the
normal publication confirmation. A configured recipe that fails cannot be
bypassed at publication.
