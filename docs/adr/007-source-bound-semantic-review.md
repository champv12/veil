# ADR-007: Bind semantic review to exact source and evidence

- **Status:** Accepted for the Phase 1 implementation
- **Date:** 2026-08-07
- **Scope:** Veil Core review contract and its local, GitHub, and Cloud views

## Context

Veil should explain a change by behavior before requiring a developer to read a
large raw diff. A prose summary alone can become stale, hide uncertainty, or
make claims that cannot be checked. Making Git commits the review identity would
also couple Veil's workflow to harmless Git mechanics.

## Decision

A **Semantic Review** is a versioned portable artifact bound to one Workspace
Tree ID and the SHA-256 digest of one complete raw diff. Its overview and
Behavioral Sections mark statements as observed, inferred, or unsupported.
Every observed or inferred statement carries exact Evidence References to diff
hunks, source ranges, or verification results. The raw diff remains a required
fallback rather than being embedded as the primary review view.

Veil rejects a review as stale whenever either source identity or raw-diff
identity changes. Deterministic local analysis and optional managed analysis use
the same contract and disclose their engine, version, and determinism. Neither
Veil Cloud nor a model-generated explanation becomes authoritative for source.

## Consequences

The CLI, GitHub adapter, and later website can share one review shape without
sharing an analysis implementation. Early local analysis can be modest and
honest while remaining compatible with richer analysis later. Users always have
an exact raw-source escape hatch, and no summary can silently survive changed
work.
