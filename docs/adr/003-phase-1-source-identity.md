# ADR-003: Separate workspace source identity from Git state

- **Status:** Accepted for the Phase 1 specification
- **Date:** 2026-08-02
- **Scope:** Open-source Veil Core and its GitHub publication adapter

## Context

Veil's normal workflow must not be disturbed by staging, branch names, or other
Git mechanics, but it still needs an exact identity for unpublished work that
can be reviewed, recovered, and safely translated into Git artifacts. Treating
the Git index or current branch as the identity would invalidate unchanged work;
treating file contents alone as the identity would miss executable, path, and
entry-kind changes that affect behavior.

## Decision

Veil separates exact workspace source identity from observed Git state:

1. A **Workspace Tree ID** is the SHA-256 digest of a versioned canonical
   manifest containing every included path, entry kind, Git-portable executable
   bit, and exact content digest. The manifest format and hashing algorithm are
   explicitly versioned.
2. A **Repository Anchor** records the full Git object ID at `HEAD` when Veil
   observes or prepares the work. Branch, index, conflict, remote, and GitHub
   state are separate Git observations and do not alter the Workspace Tree ID.
3. A **Publication Basis** binds the exact approved Workspace Tree ID to the
   current Repository Anchor immediately before publication. Identical source
   may be re-anchored quietly; any changed result requires renewed review and
   approval.
4. Existing repository exclusion rules define the default source boundary. New
   non-excluded files are included without staging. Git/Veil internals,
   credentials, caches, ignored generated output, and unsafe special files are
   excluded and reported where relevant.
5. Exact bytes and exact path spelling are authoritative. Line-ending,
   encoding, deletion, case-only path, and executable-bit changes therefore
   remain visible even when a semantic view suppresses unhelpful noise.
6. Confident renames preserve lineage; uncertain rename relationships remain
   explicitly uncertain. Normal binaries are identified exactly and described
   only through safe metadata unless a specialized preview exists.
7. Symlinks record their target without being followed outside the repository.
   Submodules record their Git pointer and use a separate nested Veil context for
   their own unpublished edits. Git LFS continues through the repository's
   existing LFS configuration.
8. A capture that observes concurrent filesystem mutation retries instead of
   claiming an inconsistent Source State. Unresolved conflict contents are
   preserved exactly but block affected publication. Previous resolutions may
   be replayed, but a changed result requires review again.

## Consequences

Semantic analysis can be reused when Git mechanics change but exact source does
not. Publication remains compatible with ordinary Git and GitHub, while Veil
can recover and review unpublished behaviorally meaningful changes without
creating its own competing source-control authority.

## Implementation status

The public `@veil/contracts` package now defines the version-1 ordinary-file
manifest and its Workspace Tree ID algorithm. It uses deterministic ordinal path
ordering, rejects Git-state fields and ambiguous or unsafe manifests, and has
executable fixtures for the canonical identity. Additional entry kinds and the
filesystem observer will extend this versioned boundary deliberately rather
than being accepted through unversioned inference.
