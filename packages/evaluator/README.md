# Recipe-driven evaluator

`@veil/evaluator` admits repository verification through a versioned,
language-neutral `VerificationRecipeV2`. Built-in detectors cover Node, Python,
Go, Rust, Java/Kotlin, Ruby, PHP, and .NET. A repository can provide
`veil.verify.json` for any other language or build system.

Recipes use argument vectors rather than interpolated shell commands. They pin
toolchains, optional setup commands, required gates, container fallback,
generated paths, and protected paths from the immutable base repository. The
same recipe digest is used for baseline, candidate, and publication checks.

```ts
const recipe = await detectVerificationRecipe(baseDirectory);
const result = await evaluateCandidate({
  candidateDirectory,
  baselineDirectory: baseDirectory,
  recipe,
});
```

When `recipe` is `null`, the result is `unchecked`; it is never reported as
verified. Missing toolchains and missing isolation are separate statuses.
Setup commands may explicitly use networking, while verification gates default
to no network.

## Evaluator-owned private gates

Encrypted evaluator-owned suites carry their own generic `CommandSpec` and
files. The existing Node adapter remains available for compatibility:

```ts
const suite = sealPrivateEvaluatorSuite(
  createExternalNodeTestSuite({
    redactedName: "private-security",
    source: externalFiveTestSource,
  }),
  evaluatorKey,
);

const result = await evaluateCandidate({
  candidateDirectory,
  recipe,
  privateEvaluator: { envelope: suite, key: evaluatorKey },
});
```

At evaluation time the suite is decrypted only under the evaluator's temporary
root, mounted read-only, and removed with that root. It is never copied into the
candidate workspace, baseline, patch, Git worktree, or returned result. Private
gate entries reveal only their redacted name and outcome.

This protects the suite from ordinary workspace access and modification. It
does not claim that malicious candidate code inside the same evaluation sandbox
cannot inspect mounted evaluator files; stronger isolation remains future
hardening work.
