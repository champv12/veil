# ADR 008: Start work in one Unassigned Change

**Status:** Accepted

## Context

Veil is meant to remove routine Git coordination from the developer's active
mental model. Requiring a title, branch name, or ticket before the first edit
would recreate the same interruption under different nouns. At the same time,
Veil needs one stable intent-level object that can own manual edits, agent runs,
recovery anchors, checks, review evidence, and eventual GitHub publication.

## Decision

Opening a new Veil context creates exactly one current **Unassigned Change**.
The user may begin work immediately. Once intent is clear, `veil change name
"INTENT"` renames the current Logical Change without requiring its internal ID.

Phase 1 keeps one current Logical Change per local context. Checkpoints are
recovery anchors inside that change, not user-facing commits. Capture produces
the current reviewable result. Git commits, branches, and a draft pull request
are created only at the publication boundary.

Direct Git activity is observed but does not silently rewrite Veil's current
change. Before publication, Veil rebases or reports an ordinary source conflict
against the current destination. The user resolves against a fresh destination
state; a destination that moves again is checked again before publication.

## Consequences

- The first edit is never blocked by naming work.
- Normal Veil commands do not require users to copy internal change IDs.
- Mixed Veil/Git teams remain compatible because Git stays authoritative for
  exact source and GitHub stays authoritative for shared merge state.
- Automatic edit assignment across several concurrent Logical Changes remains
  later Phase 1 work; this decision does not pretend it already exists.

