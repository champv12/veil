# ADR-009: Enable Bubblewrap without weakening Ubuntu AppArmor

- Status: Accepted
- Date: 2026-08-07

## Context

Veil requires a native Bubblewrap verification boundary on supported Linux
release paths. GitHub's Ubuntu 24.04 runner installed Bubblewrap 0.9.0
successfully, but the exact native-sandbox probe failed with:

```text
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor. The
restriction is a system-wide defense against kernel attack surface and must not
be disabled merely to make a release job pass. Ubuntu's `apparmor-profiles`
package includes `bwrap-userns-restrict`, a profile that grants Bubblewrap the
capabilities required to construct its namespace and strips capabilities from
the sandboxed child.

References:

- https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions
- https://packages.ubuntu.com/eu/noble-updates/all/apparmor-profiles/filelist
- https://gitlab.com/apparmor/apparmor/-/blob/v4.0.2/profiles/apparmor/profiles/extras/bwrap-userns-restrict

## Decision

1. Keep `kernel.apparmor_restrict_unprivileged_userns` enabled.
2. On Ubuntu 24.04, install the distribution-owned `apparmor-profiles`
   package, copy only `bwrap-userns-restrict` into `/etc/apparmor.d`, and load
   that profile with `apparmor_parser --replace`.
3. Run Veil's bounded Bubblewrap preflight immediately after profile loading
   in CI, protected Linux rehearsals, and release packaging.
4. Stop before product checks or public draft-PR publication if the preflight
   does not establish the native Bubblewrap boundary.
5. Document the persistent profile setup in the README, website documentation,
   and curl installer's post-install guidance. Veil does not silently request
   root access or modify AppArmor from the user-local installer.
6. Docker remains a local fallback where explicitly available, but it cannot
   satisfy the native-Bubblewrap Linux release evidence gate.

## Consequences

- Ubuntu's broader user-namespace protection remains intact.
- The elevated operation is limited to installing and loading a profile shipped
  and updated by Ubuntu rather than a Veil-authored permissive policy.
- Release evidence proves the same mount and network namespace capability that
  Veil requires before any public rehearsal publication.
- Ubuntu users must perform one explicit administrative setup step; the
  installer explains it rather than weakening the machine automatically.
- Other Linux distributions continue to use their packaged Bubblewrap without
  Ubuntu-specific AppArmor commands.

## Evidence

- Rehearsal run `31205086986` failed closed before publication when the native
  backend was unavailable.
- Diagnostic CI run `31205956366` reproduced the exact Ubuntu denial through a
  bounded preflight.
- CI run `31206324147` passed that same preflight after loading only Ubuntu's
  packaged profile and completed the full repository suite successfully.
