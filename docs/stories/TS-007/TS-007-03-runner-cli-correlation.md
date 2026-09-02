# TS-007-03 — Prove identity correlation across runner and CLI

**Status:** completed

## User Outcome

**As a** Seqlane maintainer, **I want** verified end-to-end execution correlation, **so that** future observability can rely on Work → Run → Invocation without changing the MVP boundary.

## Scope

- Update runner-client and CLI projection tests for the identity-bearing event protocol.
- Prove process-boundary preservation, repeated-run isolation, failure correlation, cancellation correlation, and repeated Task definition invocation correlation.
- Update mutable architecture index and MVP/technical docs only where their current identity terminology or event examples become stale.
- Add regression checks that Plans and public CLI/configuration do not gain Work continuation, persistence, Git provenance, or executor-specific identity.

## Out of Scope

- New CLI commands, `--work`, stored history, inspector UX, or continuation UX.
- Git integration, commit metadata, artifact queries, or telemetry export.
- Rewriting accepted/historical ADR decisions.

## Implementation Notes

Run the same unchanged fixture twice through the child-process boundary. Its workflow, Task, and Plan-node identities should match; each event stream must instead contain a different stable Work/Run pair and different runtime Invocation IDs. CLI text may remain concise, but `RunnerEventProjection.event` must retain all validated fields. Documentation must state that MVP Work is generated per Run and is not user-selectable.

## Acceptance Criteria

**Scenario:** *Independent runs do not reuse correlation identity*
- **Given:** the CLI launches the same workflow twice
- **When:** both runner executions complete
- **Then:** each stream has one internally stable Work/Run pair, and the two pairs and their Invocation IDs are different

**Scenario:** *Failures and cancellation remain correlated*
- **Given:** a task fails or a run is cancelled
- **When:** runner and CLI receive terminal events
- **Then:** the terminal event retains its initiating Work/Run pair and any invocation failure retains the related Invocation ID

**Scenario:** *MVP boundary remains closed*
- **Given:** supported CLI help, runner protocol, Plan serialization, and mutable docs
- **When:** identity regression checks run
- **Then:** they expose no Work selector, persistence, Git provenance, or executor/provider identity and do not treat Task ID as a unique correlation key

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-007 — Distinguish Work, Run, and Invocation Identity](../../ADR-007-work-run-invocation-identity-model.md)
- [TS-007 — Work, Run, and Invocation Identity Model](../../TS-007-work-run-invocation-identity-model.md)
- [TS-002 — Dedicated Runner Process and CLI IPC](../../TS-002-dedicated-runner-process.md)
- [MVP — Seqlane](../../MVP.md)
