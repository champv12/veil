# ADR 010: Manage concurrent Logical Changes through one deep module

**Status:** Accepted; supersedes ADR-008's one-current-change limit while
preserving its Unassigned Change decision.

## Context

The first Phase 1 slice stored one current Logical Change in each local context.
Adding assignment, lifecycle, recovery, review freshness, reconciliation, and
publication separately would make every client reproduce ordering and failure
rules. A goal-only workflow interface makes the common path small, but it hides
decisions that advanced clients must present explicitly.

## Decision

One deep Logical Change module owns synchronization, actions, and causally
consistent reads. Exactly one Unassigned Change exists per workspace alongside
any number of declared Logical Changes. Every Work Fragment belongs to exactly
one change. Explicit assignment wins, followed by work-session focus, lineage,
and unique high-confidence inference; ambiguous work remains Unassigned.

User-facing clients may offer the smaller `open` and goal-oriented `proceed`
workflow as an adapter over this module. The domain interface remains explicit
so restore previews, stale evidence, integration decisions, and publication
recovery cannot be hidden by client convenience code.

The same local product module owns Recovery Anchor policy and the readiness
transitions driven by evidence and external Git/GitHub observations. Durable
Publication Attempts are a separate deep module behind that product seam: the
Logical Change module decides whether a source-bound result may enter
publication, while the publication coordinator journals and reconciles remote
effects. Git, GitHub, storage, and analyzer implementations remain adapters.

The hosted control plane is intentionally not a replica of local Logical Change
state. Phase 1 does not upload names, Work Fragments, source, diffs, or Semantic
Review automatically. Its API retains a bounded single-change/run/candidate
projection and must enforce equivalent candidate-to-change ownership before it
publishes. This is a privacy boundary, not a second implementation of local
assignment or lifecycle rules.

## Consequences

- CLI, VS Code, and MCP consume one local product truth instead of
  reconstructing lifecycle and readiness independently. The web surface shows
  only the explicitly bounded hosted projection.
- Automatic assignment prefers false negatives over silent misclassification.
- Naming Unassigned creates a fresh Unassigned Change atomically.
- Paused and abandoned changes cannot receive automatic assignments.
- Split and combine reorganize Work Fragments without changing Source State.
- Restore and publication remain preview-and-confirm operations.
- A larger implementation is accepted in exchange for a small interface, high
  leverage, and locality of concurrency, staleness, and retry rules.
