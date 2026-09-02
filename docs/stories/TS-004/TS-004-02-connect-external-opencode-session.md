# TS-004-02 — Connect to one external OpenCode session

**Status:** completed

## Use Case

**As a** Seqlane operator, **I want to** connect a Run to one new session on an existing OpenCode server, **so that** all MVP tasks share repository-aware conversation context without Seqlane owning the server.

## Scope

- Create a run-scoped typed SDK client from `OpenCodeConnection.url`.
- Validate the compatible server contract before task work begins.
- Create exactly one new session for the Run.
- Keep the opaque session ID and client in private adapter state.
- Serialize adapter calls for that session.
- Report endpoint, compatibility, and session-creation errors as executor failures.

## Out of Scope

- Starting, stopping, installing, or updating OpenCode.
- Existing-session attachment, session enumeration, deletion, forks, checkpoints, or named sessions.
- Task invocation translation or output extraction.
- Parallel task calls.

## Implementation Notes

Use the public SDK configuration to target the supplied URL. Do not call a local OpenCode process helper. The adapter queue is required even though the TS-001 MVP compiler is sequential. This protects session message boundaries after later scheduler changes.

## Acceptance Criteria

**Scenario:** *A Run gets one new external session*
- **Given:** A compatible externally running OpenCode server
- **When:** The runner starts one OpenCode workflow Run
- **Then:** The adapter creates one client and one new session for that Run, and retains no raw session value outside the runner

**Scenario:** *Runs do not share session state*
- **Given:** Two sequential Seqlane Runs against the same server
- **When:** Both Runs prepare OpenCode execution
- **Then:** Each Run uses a different client, session, queue, and cancellation state

**Scenario:** *An invalid server does not change lifecycle ownership*
- **Given:** An unreachable or incompatible OpenCode URL
- **When:** The runner prepares execution
- **Then:** The Run fails with a Seqlane executor error and Seqlane does not launch, stop, enumerate, or delete OpenCode resources

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-004 — Integrate OpenCode Through a Seqlane-Owned Executor Boundary](../../ADR-004-opencode-executor-integration.md)
- [TS-004 — OpenCode Executor Integration](../../TS-004-opencode-executor-integration.md)
- [MVP — External OpenCode Only](../../MVP.md)
