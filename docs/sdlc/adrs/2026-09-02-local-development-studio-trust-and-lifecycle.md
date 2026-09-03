---
id: adr.local-development-studio-trust-and-lifecycle
title: Simplify the Local Development Studio Trust and Lifecycle
status: accepted
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - rfc.seqlane-technical-architecture
supersedes:
  - adr.local-read-only-execution-studio
---

# Simplify the Local Development Studio Trust and Lifecycle

## Context

adr.local-read-only-execution-studio defines a loopback-only, read-only Studio service with per-session
browser and CLI capabilities. The browser is opened through a one-time
bootstrap URL, and the CLI connects through a temporary session descriptor.

That boundary is appropriate for a shared or security-sensitive local
environment, but it adds friction to the intended use case: one developer
running Seqlane locally. The developer accepts that another local process can
read the Studio data or inject fake events. Studio data is already transient
and is not a production or remote service.

This ADR supersedes only the access-boundary, session-discovery, and lifecycle
details of
[adr.local-read-only-execution-studio](2026-09-02-local-read-only-execution-studio.md);
its read-only UI and event-contract decisions remain in force.

The current model also makes Studio restart recovery harder: a browser tab can
retain a stale cookie, while a descriptor and bootstrap URL belong to the
previous process.

## Decision Outcome

Seqlane will provide an explicitly local-development Studio mode with no
application-level authentication.

The service will:

- bind only to the loopback interface;
- serve the browser directly from `/` without a bootstrap token or cookie;
- expose its local snapshot and event endpoints without capabilities;
- use a fixed default loopback port so the CLI does not need a session
  descriptor;
- fail clearly when the default port is already in use; and
- continue to keep all run data in memory only.

The standalone `seqlane studio` command remains foreground and long-lived. It
supports multiple concurrent runs and stops on process termination.

The one-shot `seqlane run --studio` mode may own an ephemeral Studio for that
run. When the run finishes, the owned Studio stops and its in-memory data is
discarded. A standalone Studio is never stopped merely because one run
finishes.

This decision changes only local Studio access, discovery, and lifecycle. The
read-only UI, runner event forwarding, bounded event buffer, input/result
policy, loopback restriction, and executor-neutral contracts from adr.local-read-only-execution-studio
remain in force.

## Options Considered

### Keep per-session tokens and descriptors

This preserves the strongest local trust boundary and supports random ports.
It also keeps browser bootstrap failures, stale credentials, descriptor
cleanup, and manual session selection in the main developer workflow.

### Remove browser authentication but keep the descriptor

This makes browser access direct while retaining descriptor-based address
discovery and CLI event routing. It reduces browser friction but leaves the
descriptor lifecycle and explicit session selection in place.

### Use unauthenticated loopback access with a fixed default port

This removes the token and descriptor from the normal workflow. It matches the
single-developer use case and makes browser startup and CLI forwarding
deterministic. A local process can read or modify Studio state, and only one
default-port Studio can run at a time.

### Embed Studio in every run command

This gives the simplest one-shot workflow but cannot naturally provide one
view for concurrent runs. It also makes the standalone multi-run Studio less
useful.

## Rationale

The Studio is intentionally loopback-only, transient, read-only, and intended
for local development. The operational cost of per-session authentication is
higher than its value for this trust model. A fixed port provides the missing
service-discovery mechanism once the descriptor is removed, while preserving
the existing foreground process boundary.

## Consequences

### Positive

- The user can open `http://127.0.0.1:<default-port>/` directly.
- No stale bootstrap URL or browser cookie can block access after restart.
- The CLI no longer needs a session descriptor for the default Studio.
- One-shot runs can cleanly own and stop their Studio process.
- The loopback restriction and transient data model remain simple.

### Negative

- Any local process can read run data and post fabricated events.
- The default port cannot host two independent Studio sessions.
- Port conflicts become an explicit startup failure.
- A one-shot Studio closes when its run ends, so its in-memory history is
  lost unless the user uses standalone mode.
- Reintroducing remote, shared-machine, or durable use will require a new
  access-control decision.

## Follow-Up Constraints

- Do not expose this unauthenticated mode beyond loopback.
- Do not add durable storage or browser persistence as part of this change.
- Keep the standalone command foreground; do not create a background daemon.
- Keep `seqlane studio` and one-shot `seqlane run --studio` lifecycles
  distinct and document both.
- Remove descriptor and bootstrap-token assumptions from spec.local-read-only-execution-studio and the
  affected CLI/Studio READMEs.
- Add tests for direct browser access, unauthenticated API access, default
  port conflicts, standalone shutdown, and one-shot shutdown.

## Revisit Conditions

Revisit this decision if Studio supports remote access, multiple users,
shared development machines, durable run history, sensitive production data,
or a process lifetime that outlives the owning foreground command.

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
