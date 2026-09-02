# ADR-010 — Decouple Executor Workspace Location from Seqlane Execution Location

**Status:** Proposed
**Scope:** Private executor runtime configuration and OpenCode session binding
**Related:** ADR-002, ADR-004, ADR-007, ADR-008

## Context

Seqlane coordinates a Run from a process location. That location is currently
also used indirectly as the OpenCode server's project location because the
external server is started from a directory and the adapter creates sessions
without specifying a target workspace.

These are different concerns:

- Seqlane needs a location from which it loads workflow code and runs the
  orchestration process.
- An executor needs a workspace where it reads repository instructions and
  performs file and shell operations.
- An externally running executor server has its own process and host.

Coupling them prevents a Seqlane Run from operating on a repository when the
runner, workflow source, and executor server are in different directories or
on different hosts. It also prevents a long-running server from serving Runs
for different workspaces without being restarted in each workspace.

## Decision

Seqlane will model the executor endpoint and executor workspace as separate
private runtime concerns.

Every OpenCode-backed Run will resolve an explicit executor workspace before
creating its executor session. The adapter will pass that workspace to the
session-creation API. The OpenCode server's process working directory is not
the source of truth for the Run's workspace.

The workspace location is interpreted by the executor host. A remote server
therefore requires a path or workspace locator that is valid on that server's
host; the Seqlane process must not assume that its own filesystem is shared
with the executor.

One Run binds its OpenCode session to one executor workspace. All sequential
executor invocations in that Run use that same workspace and session. A Run
that must operate on multiple workspaces creates separate executor sessions
with separate workspace bindings.

The workspace is supplied by trusted runtime configuration. It must not be
selected by workflow source, serialized Plans, task input, or agent-generated
prompt text. Public workflow authoring and Plan contracts remain executor
neutral under ADR-008.

The adapter must fail before task execution when the workspace is missing,
invalid, or inaccessible to the executor. It must report the Seqlane
execution location and executor workspace as separate diagnostic values.

## Location Model

```text
Seqlane process / workflow location
             |
             | orchestrates
             v
          Seqlane Run
             |
             | private runtime binding
             v
Executor endpoint + executor workspace
             |
             | creates session at explicit workspace
             v
       OpenCode session
```

Starting `opencode serve` from the target workspace remains a valid local
compatibility workflow, but new runtime configuration must not depend on that
process working directory. The server may be started independently and may
serve sessions for different workspace paths, subject to its permissions and
workspace isolation.

## Options Considered

### Require the server process directory to be the target workspace

Simple and compatible with the current MVP, but couples server lifecycle,
Seqlane location, and repository location. It prevents one server from
serving independent Runs and does not work cleanly for remote execution.
Rejected.

### Start one OpenCode server per Seqlane Run

Makes workspace ownership explicit through process startup and can provide
strong isolation. It adds process lifecycle, startup latency, cleanup, and
remote deployment requirements. It also changes the external-server MVP from
ADR-004. Rejected for the current runtime model; managed per-Run servers remain
a possible future mode.

### Pass the workspace when creating each executor session

Keeps the server independently managed, supports local and remote deployment,
and gives each Run an explicit workspace binding. It requires private runtime
configuration, session API support, and workspace validation. Chosen.

### Put the workspace path in the task prompt

Requires no protocol change, but makes a security- and correctness-critical
runtime value natural language. The agent could ignore, reinterpret, or expose
the path, and the server would still have no authoritative workspace boundary.
Rejected.

## Consequences

### Positive

- Seqlane can run from one directory while operating on another repository.
- An external OpenCode server can be reused across Runs and workspaces.
- Local and remote executor deployments share one runtime model.
- Workspace selection remains outside workflow authoring and serialized Plans.
- Diagnostics can distinguish orchestration failures from executor-workspace
  failures.

### Negative

- Runtime configuration must carry and validate a workspace locator.
- The executor host must have access to the selected workspace.
- A single Run cannot switch workspaces through its existing session.
- Remote execution needs explicit path mapping or a server-side workspace
  provisioning mechanism.
- The adapter and its contract tests must cover workspace binding in addition
  to endpoint connectivity.

## Follow-up Constraints

- Extend the private runtime profile/configuration with a generic executor
  workspace field; do not add OpenCode fields to Plans or workflow authoring.
- Pass the resolved workspace through the private adapter into session
  creation.
- Normalize and validate workspace paths on the executor host, and enforce any
  configured allowed-root policy before session creation.
- Add a contract test proving that a server started from directory A can
  create a session rooted at directory B while Seqlane runs from directory C.
- Add failure tests for missing, inaccessible, and server-unresolvable
  workspaces.
- Preserve one-session, sequential execution semantics for a Run.
- Document that external-server mode does not start or stop the server, as
  established by ADR-004.

## Revisit Conditions

Revisit this decision if the executor cannot provide a reliable per-session
workspace boundary, if managed server lifecycle becomes the default deployment
mode, or if Seqlane needs concurrent multi-workspace execution within one
Run.

## Decision Test

The design is correct when a Seqlane Run launched from an arbitrary control
directory can connect to an independently started executor server and execute
against the explicitly configured workspace, without changing workflow source,
serialized Plans, or public executor-neutral contracts.
