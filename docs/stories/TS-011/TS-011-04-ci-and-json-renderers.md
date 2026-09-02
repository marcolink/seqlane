# TS-011-04 — Implement CI and JSON Renderers

**Status:** completed

## Use Case

**As a** CI operator or automation consumer, **I want to** receive useful
progress without terminal control sequences, **so that** logs remain readable
and machine processing remains reliable.

## Scope

- Implement append-only CI rendering for meaningful transitions.
- Add configurable heartbeat output for active runs.
- Include run identity, task identity, phase, elapsed time, counts, and outcome.
- Include retry attempts, skip reasons, dependency-failure reasons, and
  recoverable-error status.
- Render bounded persistent output as attributable lines.
- Produce final summary data suitable for GITHUB_STEP_SUMMARY.
- Implement one-record-per-line JSON/NDJSON output.
- Add tests for interleaved parallel tasks and nested workflow summaries.
- Verify redaction and renderer-failure isolation.

## Out of Scope

- CLI mode selection and flag parsing.
- Writing directly to process stdout or GitHub environment files.
- Full GitHub Actions annotation policy.
- Human TTY redraw behavior.
- Raw executor transcripts and token-level events.
- Rollback or compensation execution.

## Implementation Notes

The CI renderer must never use carriage returns, cursor movement, or ANSI
styling. GitHub group, warning, and error commands must be emitted only through
an explicitly enabled output capability.

The JSON renderer serializes validated, redacted runner events. It must not add
human prefixes or mix summary text into the JSON stream.

## Acceptance Criteria

**Scenario:** CI output is append-only
- **Given:** A non-interactive sink
- **When:** Task transitions occur
- **Then:** The renderer emits permanent lines without ANSI or carriage-return sequences

**Scenario:** CI output remains live
- **Given:** Active work with no durable transition
- **When:** The heartbeat timer fires
- **Then:** The renderer emits a liveness line containing run identity and elapsed time

**Scenario:** Parallel lines remain attributable
- **Given:** Interleaved events from parallel tasks
- **When:** CI lines are emitted
- **Then:** Each line identifies the relevant invocation or task

**Scenario:** Summary data is available
- **Given:** A completed nested workflow
- **When:** The renderer finishes
- **Then:** It produces a final summary with outcome, counts, durations, and failed-task details

**Scenario:** Retry and skip details are retained
- **Given:** A run containing retries and dependency-caused skips
- **When:** CI and JSON renderers process the events
- **Then:** Attempt counts, retry timing, and skip reasons remain attributable

**Scenario:** Persistent output is retained
- **Given:** An invocation emits bounded persistent output
- **When:** The CI renderer processes the event
- **Then:** It emits the output as a permanent task-attributed line

**Scenario:** JSON is machine-readable
- **Given:** A sequence of validated runner events
- **When:** JSON mode renders them
- **Then:** Stdout contains one valid JSON record per line and no decoration

**Scenario:** Renderer errors do not alter outcome
- **Given:** The output sink rejects a write
- **When:** The runner result is successful
- **Then:** The caller can preserve the successful execution status independently

## Source

- [ADR-011 — Isolate Seqlane Execution Output](../../ADR-011-dedicated-seqlane-output-package.md)
- [TS-011 — Seqlane Execution Output Package](../../TS-011-seqlane-execution-output-package.md)
- [RFC-002 — Seqlane Execution Observability and Debugging](../../RFC-002-execution-observability-and-debugging.md)
