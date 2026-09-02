# TS-016-02 — Fan Out Events to Independent CLI Consumers

**Status:** completed

## Summary

Let one run update output, Studio, and recording independently.

## Use Case

**As a** CLI user, **I want to** attach multiple execution observers to one
run, **so that** a slow or unavailable observer does not change execution or
hide terminal output.

## Acceptance Criteria

**Scenario:** *Consumers receive the same ordered stream*

- **Given:** Output, Studio, and recording consumers are enabled
- **When:** The runner emits execution events
- **Then:** Each consumer receives the canonical events in sequence order,
  including `run.plan`

**Scenario:** *One consumer fails independently*

- **Given:** A consumer queue, send operation, or handler fails
- **When:** The CLI continues supervising the runner
- **Then:** The CLI emits one bounded diagnostic, disables only that consumer,
  and preserves runner outcome and exit status

**Scenario:** *Shutdown drains cleanly*

- **Given:** The runner reaches a terminal event
- **When:** The CLI shuts down normally
- **Then:** All healthy consumers flush and close before process completion

## Technical Details

Add the generic dispatcher and lifecycle wiring to `apps/seqlane-cli`. Migrate
`seqlane-output` to consume `SeqlaneExecutionEvent` while keeping
`@seqlane/output` and `ExecutionRenderer` renderer-specific. Keep
per-consumer queues and ordering independent; bound queue failure diagnostics.
Studio publisher and the recording writer implement the generic consumer
contract without owning fanout.

Dependencies: TS-016-00 and TS-016-01. Likely files:
`apps/seqlane-cli/src/runner-client.ts`, CLI output and Studio wiring,
`libs/seqlane-output/src/**`, and consumer tests. Verify ordering,
backpressure isolation, failure isolation, flush/close, and unchanged runner
exit-status tests.

## Out of Scope

- Renaming `seqlane-output`
- Studio browser projection
- Persistent event brokers
- OpenTelemetry or CloudEvents implementations

## Source

- [ADR-016](../../ADR-016-consumer-agnostic-seqlane-execution-events.md)
- [TS-016](../../TS-016-consumer-agnostic-seqlane-execution-events.md)
- [TS-011](../../TS-011-seqlane-execution-output-package.md)
