# Windows Native Sandbox Security Contract

Status: experimental; the native Windows backend is opt-in and disabled by default.

This document defines the security boundary that a DSCode Windows sandbox must satisfy before it can
be selected for `read-only` or `workspace-write` command execution. An implementation must fail closed
until every requirement for its advertised mode is enforced and covered by Windows integration tests.

## Goals

- Run untrusted shell commands without using the interactive user's security token.
- Restrict writes to the roots allowed by the selected sandbox mode.
- Block network access unless the command has explicit network authorization.
- Contain the complete process tree and terminate it on cancellation, timeout, or helper exit.
- Preserve command arguments, standard streams, exit codes, Unicode paths, and required tool access.
- Keep Linux, macOS, Docker, and `danger-full-access` behavior unchanged.

## Non-goals

- Protect against a compromised Windows kernel or administrator.
- Treat Docker access, privileged named pipes, device access, or elevation as ordinary network access.
- Silently weaken isolation for compatibility.
- Use Low Mandatory Integrity as the primary boundary. It breaks common Git, Docker, and MSYS2
  workflows and is not sufficient for network isolation.
- Fall back to the interactive user's PowerShell when native setup or execution fails.

## Trusted components

The trusted computing base consists of:

1. The DSCode process that resolves policy and removes model credentials from the child environment.
2. A versioned, precompiled Windows runtime helper that creates the sandboxed process.
3. An elevated setup helper used only to install, upgrade, repair, or remove sandbox identities, ACLs,
   and Windows Filtering Platform rules.
4. Windows security tokens, filesystem ACLs, Windows Filtering Platform, and Job Objects.

Sandboxed commands, their descendants, project files, project configuration, hooks, and model output
are untrusted.

## Mode contract

| Mode | Workspace reads | Workspace writes | Writes outside workspace | Network |
| --- | --- | --- | --- | --- |
| `read-only` | allowed | denied | private sandbox temp only | controlled by `network` |
| `workspace-write` | allowed | allowed | private sandbox temp only | controlled by `network` |
| `danger-full-access` | host permissions | host permissions | host permissions | allowed |

`danger-full-access` is not a Windows sandbox mode. It continues to use the host PowerShell path and
must be described as unrestricted host execution.

## Identity and token requirements

- Sandboxed commands must run as dedicated, non-administrator local identities at Medium Integrity.
- Sandbox identities must be denied interactive, remote interactive, service, and batch logon except
  for the exact logon mechanism required by the runtime helper.
- Restricted primary tokens must remove unnecessary privileges and administrator-capable groups.
- Offline and online execution must use identities or token properties that cannot race with concurrent
  commands. Network policy must never be toggled globally around one command.
- Credentials for sandbox identities must be random, encrypted with DPAPI for the current DSCode user,
  and never exposed to the model or sandboxed process.
- The sandbox receives its own `USERPROFILE`, `HOME`, `TEMP`, `TMP`, and registry hive. It must not load
  the interactive user's profile or HKCU.

## Filesystem requirements

- The helper must resolve the final workspace path before applying permissions.
- Initial support is limited to local NTFS volumes. UNC paths, unsupported filesystems, and paths whose
  security descriptors cannot be verified must fail closed.
- `read-only` grants only read, execute, list, and traversal rights to the workspace.
- `workspace-write` grants workspace modification without granting ownership or ACL modification.
- Each execution receives a private writable temporary directory owned by its sandbox identity.
- The interactive user's credential and configuration roots are denied, including DSCode credentials,
  SSH keys, cloud credentials, Kubernetes configuration, and Docker configuration.
- Reparse points, junctions, symbolic links, hard links, alternate data streams, and path replacement
  races must not allow access beyond the resolved policy.
- ACL installation and removal must be idempotent, versioned, auditable, and recoverable after a crash.
- The implementation must not accumulate a new access-control entry for every command.

## Network and host-resource requirements

- `network: false` blocks IPv4 and IPv6 ingress and egress for the sandbox identity, including DNS,
  loopback, LAN, and public addresses.
- `network: true` enables ordinary network access without weakening filesystem or token restrictions.
- Network enforcement must use Windows Filtering Platform rules installed by the setup helper. Command
  parsing and environment variables are not security boundaries.
- Access to Docker, privileged named pipes, the SSH agent, GPG agent, devices, the service manager,
  scheduled tasks, and elevation remains denied unless a future separately reviewed capability grants
  that exact resource.
- `--network` must not add a sandbox identity to `docker-users` or another privileged local group.

## Process requirements

- Commands and arguments cross the helper boundary as structured values, not as a newly quoted command
  line assembled from untrusted strings.
- The helper creates the child suspended, assigns it to a Job Object, and only then resumes it.
- The Job Object uses `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and contains all descendants.
- Only the intended stdin, stdout, and stderr handles may be inherited.
- Cancellation, timeout, DSCode exit, helper crash, and normal completion must not leave descendants.
- Exit code, output bytes, environment, working directory, Unicode, spaces, and long paths must be
  preserved across the helper boundary.
- The sandboxed process must not escape through breakaway jobs or create a more privileged child token.

## Backend selection and failure behavior

1. `danger-full-access` selects unrestricted host PowerShell.
2. An explicitly configured Docker backend continues to select Docker.
3. Windows may select the native backend only when setup state, helper version, identity state, ACL
   state, and network enforcement all pass readiness checks.
4. Any missing helper, unsupported architecture, stale setup, access-denied setup state, malformed
   response, or enforcement failure produces a clear error and does not run the command.

The backend description must identify the actual enforcement mechanism. Process containment alone must
be labelled `Windows process containment`, never `Windows sandbox`.

## Required acceptance tests

The native backend cannot be advertised until the following tests pass on `windows-latest` and a
non-administrator Windows test account.

### Filesystem

- `FS-01`: both confined modes can read normal workspace files.
- `FS-02`: `read-only` cannot create, overwrite, rename, or delete workspace files.
- `FS-03`: `workspace-write` can perform those operations inside the workspace.
- `FS-04`: neither confined mode can write the workspace parent or interactive user profile.
- `FS-05`: both confined modes can write only their private temporary directory outside the workspace.
- `FS-06`: junction, symlink, hard-link, reparse-point, and path-swap escape attempts fail.
- `FS-07`: Git can create `.git/index.lock` in `workspace-write` and cannot do so in `read-only`.
- `FS-08`: ACL state is stable after success, failure, helper crash, repair, and uninstall.

### Network and host resources

- `NET-01`: offline execution cannot use DNS, TCP, UDP, IPv4, IPv6, loopback, LAN, or public network.
- `NET-02`: online execution can reach explicitly testable loopback and public endpoints.
- `NET-03`: online execution still cannot access Docker or privileged named pipes.
- `NET-04`: concurrent online and offline commands retain their respective policies.

### Process and protocol

- `PROC-01`: normal commands preserve stdout, stderr, stdin, and exit status.
- `PROC-02`: cancellation and timeout terminate child and grandchild processes.
- `PROC-03`: helper or DSCode termination leaves no sandbox process running.
- `PROC-04`: paths and arguments containing spaces, quotes, apostrophes, Unicode, and long paths work.
- `PROC-05`: malformed or version-incompatible helper messages fail closed.
- `PROC-06`: inherited handles and environment variables contain no model credentials or host secrets.

### Setup and lifecycle

- `SETUP-01`: install, repeated install, upgrade, repair, and uninstall are idempotent.
- `SETUP-02`: partial installation and interrupted upgrade are detected and repaired or rejected.
- `SETUP-03`: sandbox identities cannot log on interactively and are not administrators.
- `SETUP-04`: uninstall removes identities, WFP rules, stored credentials, and DSCode-owned ACL entries.
- `SETUP-05`: x64 and ARM64 packages select only a matching, checksum-verified helper.

## Rollout gates

1. Ship helper process and Job Object tests without advertising filesystem or network isolation.
2. Enable an experimental `read-only` backend only after all applicable identity, filesystem, process,
   and setup tests pass.
3. Add `workspace-write` only after its complete filesystem matrix passes.
4. Add offline/online switching only after WFP and concurrency tests pass.
5. Keep the backend opt-in until Windows CI, package verification, upgrade, repair, and uninstall tests
   are stable across supported Windows versions and architectures.

No rollout gate may be bypassed by documentation, UI wording, or a runtime fallback.
