# Veil product boundary

The complete staged product direction is recorded in the
[developer-workflow roadmap](./developer-workflow-roadmap.md). This document
defines the narrower boundary of the currently shipped product.

This is the canonical product-language reference for the website, CLI, VS Code
extension, Codex plugin, demos, and planning documents.

## Phase 1 direction under specification

The next workflow is being charted in the
[Phase 1 Git-backed workflow Wayfinder](./phase-1-wayfinder.md). Its destination
is a Veil-native daily workflow in which developers organize, understand,
review, and share Logical Changes without needing Git staging, branch, commit,
push, or pull-request mechanics as their primary mental model.

Git remains the exact committed-source substrate and GitHub remains compatible
with mixed teams. Veil Core remains open source, local-first, and useful without
a Veil account; the private Veil Cloud product adds optional hosted analysis,
persistence, synchronization, and collaboration. The Wayfinder map is
authoritative while this direction is being specified. The sections below
continue to describe the currently implemented alpha.

## Product promise

**Veil lets maintainers work privately before Git. A person or agent harness
works in one private workspace; Veil captures and checks the current result,
then publishes only what the maintainer approves.**

A local clone already keeps unpushed edits and commits private. Veil does not
claim otherwise. Its value begins when pre-publication work needs to be durable,
available to authorized tools, verified away from the original workspace, and
published deliberately without creating public intermediate branches or
maintaining a separate private Git mirror.

## Primary user

Open-source maintainers and small engineering teams preparing proprietary or public security fixes,
features, and maintenance changes that should not be visible on public Git
hosting until they are ready.

External contributors can use Veil to prepare and export a patch, but Veil does
not bypass repository permissions. Creating a branch or pull request still
requires upstream write access, an installed repository-authorized GitHub App,
or the normal fork-and-PR workflow.

## The workflow

1. **Open** a supported public repository URL or clean local GitHub checkout at an immutable base commit.
2. **Work** manually or with an agent harness in one managed no-`.git` view.
3. **Capture** the current result as an encrypted immutable snapshot.
4. **Check** the reconstructed result, sanitized diff, provenance, and verification gates.
5. **Publish** only after explicit confirmation, as a patch or draft pull request.

Manual work and agent-assisted work follow the same linear capture, check, and
publication path. Veil does not ask the maintainer to choose among generated
alternatives.

## Privacy boundary

Veil keeps private work out of public Git refs until publication. Durable local
state is encrypted, disposable workspaces contain no `.git` directory or
publication credentials, and private briefs, raw traces, and superseded
snapshots are excluded from publication.

Veil does not claim secrecy from the user's operating-system account, editor,
authorized local tools, or an authorized model provider while they are working
with plaintext. The current alpha also does not claim forensic erasure or
production-grade containment for arbitrary untrusted repositories.

## Surface responsibilities

| Surface | Responsibility |
| --- | --- |
| CLI | Complete local workflow and automation; no browser or daemon required |
| VS Code extension | Hands-on manual or agent-assisted work through the same local CLI operations |
| Codex plugin | A guided agent interface over the bounded local MCP server |
| Website | Onboarding and documentation; optional hosted monitoring for invited tenants |
| Hosted dashboard | Observability only; it does not own or execute local work |

Every surface must use the same verbs: **open, work, capture, check, publish**.
The choice of editor or agent harness, cloud infrastructure, identity providers,
storage vendors, IPC details, and cryptographic algorithms are implementation
details, not the headline product story.

## Current alpha scope

- macOS and Linux
- public GitHub URL imports and clean, already-authenticated local GitHub checkouts, including private repositories
- language-neutral repository admission
- detected or configured verification recipes; repositories without one remain usable and are labeled unchecked
- local OS-sandboxed verification; Docker is optional
- local Codex CLI for agent work
- patch export or draft pull request publication
- one linear private result per change, whether written manually or with an agent harness

Hosted private-repository import, Windows, hosted execution,
hardened arbitrary-code isolation, and automatic publication are deferred.
