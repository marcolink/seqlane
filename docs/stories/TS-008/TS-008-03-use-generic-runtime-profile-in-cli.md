# TS-008-03 — Use a generic runtime profile in the CLI

**Status:** completed

## Use Case

**As a** Seqlane operator, **I want to** select a generic runtime profile for a Run, **so that** the CLI does not expose executor implementation configuration.

## Scope

- Replace `OpenCodeConnection` in core runner protocol with a generic runtime profile reference.
- Replace `--opencode-url` with required generic `--runtime` CLI input.
- Pass the generic profile unchanged from CLI to runner IPC.
- Resolve the profile to private binding and adapter state inside the runner.
- Update protocol, command, runner-client, and CLI entrypoint tests.

## Out of Scope

- A documented OpenCode endpoint, provider, model, or permission configuration field.
- Workflow-level runtime profile selection.
- Public runtime plugin discovery or a user-facing configuration schema.
- OpenCode adapter request behavior.

## Implementation Notes

`RuntimeProfileReference.id` is the only public runtime selection data. The private runner profile provider maps it to adapter state. Tests can inject that provider. Reject the former OpenCode field and flag instead of retaining compatibility aliases.

## Acceptance Criteria

**Scenario:** *Runner IPC is executor-neutral*
- **Given:** A valid `run.start` command
- **When:** Core protocol encodes and decodes it
- **Then:** It contains workflow, input, and a generic runtime profile without OpenCode or executor fields

**Scenario:** *The CLI exposes generic runtime input*
- **Given:** An operator runs `seqlane run`
- **When:** oclif parses flags and help
- **Then:** It requires `--runtime`, rejects `--opencode-url`, and documents no executor implementation option

**Scenario:** *Private profile resolution stays in the child*
- **Given:** A valid CLI request and a test profile provider
- **When:** The CLI starts the runner
- **Then:** The parent sends only the profile reference and the child creates private binding state

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-002 — Execute Each Seqlane Run in a Dedicated Node Process](../../ADR-002-dedicated-runner-process.md)
- [ADR-008 — Keep Workflow Authoring and Plans Executor-Neutral](../../ADR-008-executor-neutral-workflow-authoring.md)
- [TS-008 — Executor-Neutral Workflow Authoring](../../TS-008-executor-neutral-workflow-authoring.md)
