# TS-011 — Seqlane Execution Output Package

**Status:** Implemented
**Implements:** ADR-011
**Depends:** TS-002, TS-007
**Scope:** MVP execution output projections and renderers

## 1. Objective

Create a private output package that consumes Seqlane runner events and renders
the same execution through human TTY output, non-interactive CI output, and
machine-readable JSON/NDJSON output.

The CLI selects and connects a renderer. It does not reduce execution state or
own terminal layout. The runner and runtime remain responsible for execution
and event emission.

    RunnerEvent
        ↓
    seqlane-output event reducer
        ↓
    human / CI / JSON renderer
        ↓
    CLI output sink

## 2. Normative Invariants

- The package is created at libs/seqlane-output and is named
  @seqlane/output.
- The package is private and exposes only intentional package exports.
- The package depends on @seqlane/events for canonical serialized
  event contracts and on @seqlane/core only for shared Seqlane
  primitives.
- The package does not depend on Mastra, OpenCode, seqlane-runtime, or
  workflow-authoring implementation details.
- Canonical execution events remain the source of truth. View models and
  terminal output are projections.
- The package does not own runner transport, process termination, signal
  handling, or exit-status mapping.
- Human mode represents workflow containment separately from scheduling
  dependencies.
- Nested workflow rows use parent invocation identity for visual containment.
- Dependency identities remain separate so parallel and cross-branch waits can
  be explained accurately.
- Human rows have stable plan order. Event arrival order must not reorder rows.
- Completed work can collapse; active work remains visible; failed work exposes a
  concise failure summary.
- CI mode never emits ANSI control sequences or carriage-return redraws.
- Auto mode uses CI output when the terminal cannot safely support ANSI
  redraws, preventing repeated full-frame output.
- JSON/NDJSON mode emits machine-readable records without human decoration.
- Redaction occurs before sensitive event data reaches output projections.
- Transient activity and persistent output are represented separately.
- Human output renders tool and skill activity separately: current activity
  during execution, then distinct used-tool and used-skill summaries after the
  task or run completes.
- Persistent task output may include normalized execution metrics and a bounded
  shape-only summary of the validated result.
- Retry state exposes attempt, delay, next-attempt time, and last error.
- Skip, failure, continuation, and cancellation reasons are explicit; renderers
  do not infer execution policy from missing events.
- Renderer capabilities include TTY, ANSI, Unicode, width, resize, and output
  stream routing.
- Renderer failures must not change the runner result or process exit status.
- Breaking changes to the current MVP protocol are allowed; compatibility
  aliases are not required.

## 3. Package Contract

The package must provide a renderer boundary equivalent to:

    interface ExecutionRenderer {
      handle(event: SeqlaneExecutionEvent): void;
      finish(): Promise<void>;
    }

The renderer writes through injected output capabilities:

    interface OutputCapabilities {
      readonly isTTY: boolean;
      readonly supportsAnsi: boolean;
      readonly supportsUnicode: boolean;
      readonly width: number;
      readonly stdout: OutputSink;
      readonly stderr: OutputSink;
      readonly summary?: OutputSink;
    }

    interface OutputSink {
      write(value: string): void | Promise<void>;
      flush?(): Promise<void>;
    }

The renderer must not call process.stdout, process.stderr, process.exit, or
environment-specific APIs directly. The CLI supplies capabilities and updates
terminal width after resize. The output boundary must coordinate redraw frames
with other diagnostics so concurrent writes cannot corrupt the human display.
JSON mode reserves stdout for JSON records; human and CI diagnostics use the
configured diagnostic sink.

The package provides these modes:

- human — live TTY renderer with nested collapse and active-task detail;
- ci — append-only progress lines, heartbeat output, and final summary data;
- json — one stable machine-readable record per line;
- auto — selected by the CLI, using human mode only for an interactive TTY
  outside CI.

The exact terminal library is not part of the package contract. Listr2,
log-update, ANSI utilities, or another implementation may be used behind the
renderer boundary.

## 4. Runner Event Requirements

Every runner event carries runner-owned metadata:

    interface RunnerEventMetadata {
      readonly schemaVersion: 1;
      readonly eventId: string;
      readonly sequence: number;
      readonly occurredAt: string;
    }

The sequence is monotonically increasing within one run. occurredAt is an
absolute UTC timestamp. eventId is unique within the emitted run history.

The event model must provide these capabilities.

### Invocation creation

An invocation.created event is emitted before execution starts for every known
invocation. Dynamic nested invocations emit the event when discovered.

It contains:

- invocation ID;
- task ID and human-readable label;
- kind: workflow or task;
- optional parent invocation ID;
- stable sibling order;
- dependency invocation IDs.

### Progress and waiting

An invocation.progress event communicates the current state, phase, and
redacted activity message. It may also carry an updated human label. Waiting
data includes a reason and, when relevant, dependency IDs.

Progress events are transient and may be coalesced by renderers. They must not
be emitted per token or per raw executor update.

### Output

An invocation.output event carries redacted output with an explicit rendering
policy:

- transient activity replaces or updates the current task detail;
- persistent output is retained after task completion;
- output channel identifies task detail versus run-level diagnostics;
- output content is bounded or summarized before it crosses the runner
  boundary.
- A persistent output event may carry Seqlane-owned metrics: duration, model,
  provider, cost, and token counts.
- A persistent output event may carry a shape-only summary with kind, size, and
  up to eight object field names. Raw result values, prompts, transcripts, tool
  output, and secrets do not cross the `invocation.output` channel.

TS-013 adds separate, optional `invocation.input` and `invocation.result`
events for the local Studio inspector. These events use a Seqlane-owned
display-value contract. The runtime applies redaction and value limits before
it emits them. TTY, CI, and JSON renderers can ignore these events.

The event model does not expose unrestricted executor stdout, stderr, prompts,
or token streams.

### Retry

An invocation.retrying event carries the current attempt, maximum attempts when
known, retry delay or next-attempt timestamp, and the last redacted failure.
Renderers show retry state and countdown without treating a retry as a new
logical invocation.

### Failure, skip, and continuation policy

Terminal invocation events carry a reason where applicable. The event stream
must distinguish a task that failed, a task skipped because a dependency failed,
a task cancelled by run policy, and a task that continued after a recoverable
error.

The output package reports all invocation failures available in the event
stream, not only the final run error. Execution policy remains owned by the
runtime. The event data exposes a bounded disposition such as
retry_scheduled, fail_run, continue_siblings, skip_dependents, or
cancelled_by_policy so renderers do not guess whether work continued.

Rollback or compensation execution is not introduced by TS-011. If a future
runtime adds it, it must emit explicit rollback lifecycle events or a reserved
rollback phase; the renderer must not infer rollback from cancellation or
failure.

### Run liveness

A run.heartbeat event is emitted while active work has not produced a durable
state transition for the configured heartbeat interval. The default interval
is 15–30 seconds and must be injectable in tests.

### Terminal state

Existing invocation and run terminal events remain authoritative:

- invocation.succeeded;
- invocation.failed;
- invocation.cancelled;
- invocation.skipped;
- run.succeeded;
- run.failed;
- run.cancelled.

The core protocol validators, runtime event bridge, runner transport, and
protocol tests must accept and preserve the complete event contract.

## 5. Human View Model

The human projection maintains a normalized map of execution nodes:

    interface HumanExecutionNode {
      readonly invocationId: string;
      readonly kind: "workflow" | "task";
      readonly label: string;
      readonly parentInvocationId?: string;
      readonly siblingOrder: number;
      readonly dependencyIds: readonly string[];
      readonly state: HumanNodeState;
      readonly aggregate: HumanAggregate;
      readonly output: HumanOutputState;
      readonly retry?: HumanRetryState;
      readonly failure?: HumanFailureState;
      readonly skipReason?: string;
      readonly presentation: HumanPresentationState;
    }

    interface HumanOutputState {
      readonly transient?: string;
      readonly persistent: readonly string[];
      readonly metrics?: SeqlaneInvocationMetrics;
      readonly summary?: SeqlaneOutputSummary;
    }

    interface HumanRetryState {
      readonly attempt: number;
      readonly maximumAttempts?: number;
      readonly nextAttemptAt?: string;
      readonly lastError?: string;
    }

Containment is rendered as a tree. Dependencies remain a separate graph:

    containment: workflow → nested workflow → task
    dependency:  task A → task B

The view model derives:

- visible rows from root nodes and expansion state;
- indentation from containment depth;
- waiting explanations from dependency state;
- aggregate counts for workflow rows;
- transient and persistent output according to output policy;
- retry countdown and last failure;
- failure and skip summaries;
- active task focus from renderer-local state;
- elapsed time from event timestamps and an injected clock.

The view model must handle:

- nested workflows with multiple levels;
- parallel sibling tasks;
- tasks waiting on multiple dependencies;
- dynamically discovered children;
- retries and repeated invocation attempts;
- skipped, cancelled, and failed descendants;
- transient activity and persistent output;
- retry attempts and retry delays;
- recoverable errors and dependency-caused skips;
- stable ordering when events arrive interleaved.

Percent completion is not the canonical progress measure. Renderers use counts
such as completed, active, waiting, failed, and total.

## 6. Renderer Behavior

### Human renderer

- Uses a live redraw only when the output sink supports TTY behavior.
- Shows a stable row for each known node.
- Shows one or more active rows for parallel work.
- Expands the focused active branch by default.
- Collapses completed nested workflows to an aggregate row.
- Keeps failed nodes expanded enough to show a concise error.
- Shows skip reasons and retry attempt/countdown information.
- Renders transient activity separately from persistent output.
- Shows the currently used tool during execution, adds a per-task distinct tool
  summary on completion, and prints a run-level usage list after completion.
- Preserves configured persistent output after task completion.
- Shows bounded output shape and available execution metrics without exposing
  task result values.
- Truncates activity text to the available terminal width.
- Reflows after terminal resize.
- Disables color and Unicode independently when capabilities do not support
  them.
- Uses semantic Unicode status and detail icons in human mode when supported;
  falls back to unambiguous ASCII status markers otherwise.
- Supports a verbose setting that exposes all active task details.

### CI renderer

- Emits permanent lines for meaningful state transitions.
- Emits a periodic heartbeat while the run is active.
- Uses no ANSI styling, cursor movement, or carriage-return redraw.
- Includes run ID, invocation/task label, phase, elapsed time, counts, and
  terminal outcome.
- Includes retry, skip, failure, and dependency-wait reasons when present.
- Emits persistent output as bounded, attributable lines.
- Includes available execution metrics and output shape on persistent output
  lines.
- May emit GitHub Actions group, warning, and error commands through an
  explicitly enabled sink.
- Produces final summary data for the CLI to write to GITHUB_STEP_SUMMARY when
  available.

Parallel task output is allowed to interleave, but each line includes enough
identity to remain understandable without terminal cursor state.

### JSON renderer

- Emits one JSON object per line.
- Preserves event type, identity, sequence, timestamps, and redacted data.
- Emits no human text, ANSI codes, or summary decorations to stdout.
- Provides deterministic serialization for tests and CI consumers.
- Preserves the distinction between transient activity and persistent output.

## 7. CLI Integration

The CLI adds an output mode option:

    --output auto|human|ci|json

The CLI:

- resolves auto mode from TTY and CI capabilities;
- creates the selected renderer;
- passes raw validated runner events to the renderer;
- waits for renderer finalization before exiting;
- maps the runner result to the process exit status independently;
- writes optional CI summary data through an injected or CLI-owned summary
  sink.

The existing direct event-to-line projection is removed or reduced to a
compatibility-free internal adapter during migration. Runner supervision keeps
its current terminal event and cancellation semantics.

## 8. Package and Build Contract

The package contains, at minimum:

    libs/seqlane-output/
      package.json
      project.json
      tsconfig.json
      src/
        index.ts
        renderer-contract.ts
        event-reducer.ts
        human/
        ci/
        json/

The package exports only its supported renderer factory, renderer contract, and
renderer-facing types. Cross-package imports use declared workspace
dependencies and package exports. Relative source or dist imports are
forbidden.

## 9. Required Tests

Tests must prove:

- package build and exports work from compiled output;
- the package has no Mastra, OpenCode, or runtime dependency;
- event metadata and topology fields round-trip through the runner protocol;
- nested workflow relationships render with correct indentation and collapse;
- dependency relationships explain parallel waiting without changing
  containment;
- interleaved parallel events preserve stable row ordering;
- retries, failures, cancellation, skipping, and dynamic children update the
  view model correctly;
- human output redraws only through a TTY-capable sink;
- CI output contains no ANSI or carriage-return redraw sequences;
- CI heartbeats are emitted using an injectable timer;
- transient and persistent output follow their configured policies;
- output metrics and bounded output summaries round-trip and render in human,
  CI, and JSON modes;
- retries expose attempt, delay, countdown, and last error;
- skip and continuation reasons remain attributable;
- no-color, no-Unicode, narrow-terminal, and resize cases render safely;
- concurrent diagnostic writes cannot corrupt a human frame;
- JSON output is one valid record per line;
- renderer failures do not change runner exit status;
- sensitive values do not appear in output;
- CLI auto mode selects human output only for interactive non-CI execution;
- all workspace quality gates pass.

## 10. Explicitly Deferred

TS-011 does not implement:

- Mastra Studio, Mastra tracing, or external observability storage;
- persistent run records or local run inspection;
- token-level or unrestricted executor transcript streaming;
- keyboard navigation or a full-screen interactive inspector;
- replay, run comparison, or historical diff;
- external CI summary upload;
- a public renderer plugin API;
- rollback or compensation execution semantics;
- direct Stream or Observable execution support; only their redacted output
  events may be rendered;
- a final decision to use Listr2 versus a custom ANSI renderer;
- percentage-based progress guarantees for dynamic workflows.

## 11. Delivery Order

1. Bootstrap the private output package and renderer contract.
2. Extend the event protocol with metadata, topology, progress, and heartbeat
   events.
3. Implement the pure human view-model reducer.
4. Implement the human TTY renderer.
5. Implement CI and JSON renderers.
6. Integrate the package with the CLI and complete boundary, documentation,
   and quality verification.

## 12. Acceptance Criteria

TS-011 is complete when:

- execution output is implemented in @seqlane/output;
- core and runtime remain free of terminal renderer dependencies;
- nested workflows and parallel tasks are represented and rendered correctly;
- human, CI, and JSON modes consume the same validated event stream;
- GitHub Actions output is append-only and remains useful without a TTY;
- the CLI remains responsible for mode selection and exit status only;
- renderer and event-sequence tests cover the required behavior;
- all workspace quality gates pass.

## 13. Listr2 Reference Behavior

The human renderer is informed by Listr2 behavior but does not adopt Listr2 as
the execution model. The relevant reference behaviors are documented at:

- https://listr2.kilic.dev/task/subtasks.md
- https://listr2.kilic.dev/task/output.md
- https://listr2.kilic.dev/task/retry.md
- https://listr2.kilic.dev/task/error-handling.md
- https://listr2.kilic.dev/task/rollback.md
- https://listr2.kilic.dev/renderer/fallback-condition.md
- https://listr2.kilic.dev/renderer/process-output.md
- https://listr2.kilic.dev/listr/interruption.md

The current visual alignment follows Listr2's documented default-renderer
behavior: live task rows, indented nested output, persistent completed output,
and Unicode fallback based on terminal capability. Seqlane keeps its own
semantic status model and uses icons for output shape, model, timing, tokens,
and cost; CI and JSON remain text/machine-readable.
