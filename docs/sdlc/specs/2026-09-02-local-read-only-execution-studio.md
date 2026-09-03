---
id: spec.local-read-only-execution-studio
title: Local Read-Only Execution Studio
status: active
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - adr.local-read-only-execution-studio
supersedes: []
---

# Local Read-Only Execution Studio

> Migrated from legacy technical specification `TS-013`.

## 1. Objective

Provide a foreground, machine-local Studio service that lists registered
Seqlane runs and shows each active run as a live, read-only invocation graph.

The Studio service receives a copy of canonical runner events from the CLI. It
gives browser clients a current snapshot and Server-Sent Events (SSE). It does
not persist run history or control execution.

```text
runner process
      │ Seqlane IPC
      ▼
CLI supervisor ── ordered event copy ──► Studio service ──► browser
                                           registry     snapshot + SSE
```

## 2. Normative Invariants

- Studio is a foreground, loopback-only service. It is not a persistent
  Seqlane daemon.
- The Studio service has no executor, Mastra, or executor-connection data.
- The runner remains the source of canonical Seqlane events.
- The CLI forwards events after it validates runner IPC. It does not change
  event meaning, allocate IDs, or make execution depend on Studio delivery.
- A Studio delivery error, a queue overflow, or a Studio shutdown must not
  change runner execution, cancellation, terminal events, or CLI exit status.
- Studio lists only runs registered with that Studio session. It does not
  discover unrelated operating-system processes.
- A `runId` identifies all Studio state for one run. Workflow ID, task ID, and
  Plan-node ID are not run keys.
- Every Studio-visible runner event has complete runner metadata. The metadata
  sequence is monotonic within its run.
- Studio uses a separate monotonic stream cursor for its multiplexed SSE feed.
  It does not treat a per-run metadata sequence as globally ordered.
- The service stores only bounded, in-memory active-run state and event data.
  Restarting the service erases this state.
- Browser clients obtain updates through SSE. They do not poll.
- Studio is read-only. The browser has no cancel, retry, approval, or workflow
  editing operation.
- The graph identifies an actual node by `invocationId`. It keeps its static
  source address in `planNodeId`.
- Input and result display values are JSON values that Seqlane redacts and
  bounds before it sends them outside the runner process.
- A display value must say whether it is present, redacted, truncated, or
  omitted. A missing event is not a display-state signal.
- Packages use declared dependencies and package exports only.

## 3. Components and Ownership

| Component | Ownership |
| --- | --- |
| `@seqlane/core` | Shared public primitives and contracts used by Studio, including IDs and the JSON display-value contract. |
| `@seqlane/events` | Canonical execution-event types, protocol guards, encoding, and event validation consumed by Studio. |
| `@seqlane/runtime` | Private input/result capture, redaction and bounds application, `planNodeId` propagation, and canonical event emission. |
| `@seqlane/output` | Existing renderers. It accepts the extended event union and ignores Studio-only value events unless a renderer later uses them. |
| `seqlane` | Foreground Studio command, Studio-session loading, ordered best-effort event publisher, and existing runner supervision. |
| `apps/seqlane-studio` | One private deployable application with a Node service and browser client. It owns the local HTTP service, registry, transport, projection, and read-only interface. |

The service and client are separate runtime layers in one private application.
They share a browser-safe Studio protocol module. The application imports
Seqlane event contracts from package exports. It does not import runtime or
CLI source files.

### 3.1 V1 stack

- The Node service uses TypeScript and native `node:http`. It serves the built
  browser files, local JSON endpoints, and SSE. V1 adds no HTTP framework.
- The browser client uses React 19 and the existing Vite build tooling.
- The graph canvas uses `@xyflow/react` 12.11.3. Studio disables every graph
  editing capability.
- The browser reduces snapshots and `EventSource` events with local React
  state. V1 adds no global-state or server-state library.
- The graph uses a local deterministic layered layout. V1 adds no layout
  library.
- The browser uses native CSS or CSS modules. V1 adds no design-system package.

## 4. Studio Session and Lifecycle

The CLI provides a `seqlane studio` command. The command starts one local
Studio service in the foreground. It binds to `127.0.0.1` or the IPv6 loopback
address on an available port. It never binds to a network interface.

At startup, Studio creates a random session capability. It writes a
mode-`0600` session descriptor file. The descriptor contains the local service
address and capability. Studio removes the file when it stops.

The `seqlane run` command accepts a `--studio <descriptor-file>` option. The
CLI validates the descriptor before it starts a runner. It rejects a descriptor
whose address is not loopback. The CLI does not print the capability or include
it in ordinary diagnostics.

Studio opens the browser with a local bootstrap URL. The bootstrap URL creates
a same-origin, session-scoped browser credential. The browser uses that
credential for snapshots and SSE. Browser and CLI credentials expire when the
Studio process stops.

One Studio service can receive events from many concurrent CLI processes. A
user can start more than one Studio service only by using distinct descriptor
files. Each CLI forwards to only the Studio session selected by its option.

Studio uses no database, browser persistence, background process, remote
service, or user account in this release.

## 5. Runner Event Extensions

### 5.1 Invocation topology

`invocation.created` adds a required `planNodeId: PlanNodeId` field. The
runtime sets it from the Plan node that allocates the invocation. A dynamic
invocation reports the static Plan node that created it.

`invocationId` remains the identity for one actual execution. `planNodeId`
remains a static Plan address. Studio must not use either ID as a substitute
for the other.

### 5.2 Display values

Core adds this serializable, Seqlane-owned display-value contract:

```ts
type SeqlaneDisplayValue =
  | { readonly state: "present"; readonly value: JsonValue }
  | { readonly state: "redacted"; readonly summary?: SeqlaneOutputSummary }
  | { readonly state: "truncated"; readonly summary: SeqlaneOutputSummary }
  | { readonly state: "omitted"; readonly reason: "policy" | "unavailable" };
```

`@seqlane/events` adds two canonical execution-event variants:

```ts
interface InvocationInputEvent {
  readonly type: "invocation.input";
  readonly metadata: SeqlaneExecutionEventMetadata;
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly input: SeqlaneDisplayValue;
}

interface InvocationResultEvent {
  readonly type: "invocation.result";
  readonly metadata: SeqlaneExecutionEventMetadata;
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly result: SeqlaneDisplayValue;
}
```

The protocol guards, encoders, decoders, and event bridge must preserve these
events. New events use the existing runner metadata. They do not add a second
event sequence.

The runtime emits the events in this order when the relevant value exists:

```text
invocation.created
invocation.started
invocation.input
invocation.output (zero or more)
invocation.result
invocation.succeeded
```

An input-resolution or output-validation error can omit the corresponding
value event and then emit the existing failure event. The event sequence must
not emit `invocation.result` before output validation succeeds.

### 5.3 Value-display policy

The runtime applies a Seqlane-owned value-display policy before it emits an
input or result event. The default policy includes the bounded root value.
An explicit empty selection emits `{ state: "omitted", reason: "policy" }`.

Task definitions can provide generic, Seqlane-owned observability metadata.
For each input or result, the metadata can select safe JSON Pointer paths. The
runtime builds a projection from these selected paths and omits every other
path. When metadata is absent, the full root value is selected subject to the
display limits below. An empty selection explicitly omits the value.

```ts
type SeqlaneJsonPointer = string;

interface SeqlaneStudioValueSelection {
  readonly includePaths: readonly SeqlaneJsonPointer[];
}

interface SeqlaneTaskObservability {
  readonly studio?: {
    readonly input?: SeqlaneStudioValueSelection;
    readonly result?: SeqlaneStudioValueSelection;
  };
}
```

`TaskDefinition` adds an optional `observability` field with this type.
`SeqlaneJsonPointer` uses RFC 6901 syntax. The empty pointer selects the full
value. A task author can use a path selection when the default root display is
too broad, and must select only values that are safe for local Studio
inspection.

The metadata is executor-neutral. It remains in the in-memory task definition
with schemas and callbacks. It does not serialize into a Plan.

The policy is independent of executors and must not expose executor prompts,
sessions, model configuration, tools, or connection details. The first policy
contract must support field-level path selection. It must treat unknown values
as omitted, not present.

The runtime applies these limits to the selected projection:

- The encoded JSON value must not exceed 32 KiB.
- A value must not have more than 16 nested containers.
- An object or array must not have more than 100 direct entries.

If a projection exceeds one limit, the runtime emits a truncated value with a
`SeqlaneOutputSummary` for the selected projection. It does not send a partial
raw value. A redacted value can include the same bounded summary only when it
does not disclose an unselected path.

`invocation.output` remains a bounded execution-output channel. It is not a
replacement for the validated structured result.

`invocation.activity` provides bounded tool and skill lifecycle entries for
active invocations. Tool and skill input, output, and executor metadata include
the bounded root value by default; task metadata can select narrower fields or
explicitly omit a value. Skill entries mean the executor loaded a skill; they do
not prove that every skill instruction was followed. Studio shows distinct
used-tools and used-skills lists above the full event timeline and stores only a
bounded recent activity history.

## 6. Event Forwarding

The CLI creates a Studio publisher only when `--studio` is present. The
publisher receives each decoded `RunnerEvent` in the same callback that sends
the event to the selected CLI renderer.

The publisher sends this envelope to Studio:

```ts
interface StudioIngestEvent {
  readonly workflowId: string;
  readonly event: RunnerEvent;
}
```

`workflowId` comes from the accepted `RunRequest`. It is descriptive context.
Studio takes Work and Run identity only from the runner event.

The publisher queues deliveries in metadata-sequence order for each run. It
must have a finite queue. If the queue overflows or delivery fails, the
publisher stops forwarding that run and reports one local diagnostic. It does
not delay the renderer or runner supervision.

Studio deduplicates an event by `(runId, metadata.sequence)` and `eventId`.
If it observes a gap, it sets `isIncomplete` on the run. The browser shows this
condition. Studio must not infer the missing events.

Studio creates a run record on its first accepted `run.started` event. It
rejects events without metadata, events that use a different workflow ID for
an existing run, or events after a terminal run event. Terminal runs remain in
the in-memory run list until Studio stops or evicts them under its active-run
memory budget.

## 7. Local HTTP Contract

All endpoints are same-origin and require the Studio session capability. The
browser client uses the session credential. The CLI publisher uses the session
descriptor capability.

### Snapshots

`GET /api/runs` returns all current summaries and the current stream cursor.

```ts
interface StudioRunSummary {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly workflowId: string;
  readonly state: "active" | "succeeded" | "failed" | "cancelled";
  readonly isIncomplete: boolean;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly activeInvocationCount: number;
  readonly lastEventSequence: number;
}
```

`GET /api/runs/:runId` returns one reduced run projection and the stream cursor
at which that projection is valid. The projection contains invocation nodes,
their dependency and containment identities, current display values, event
state, and terminal error data. It does not contain executor-private values.

Unknown run IDs return `404`. A malformed or unauthorized request returns one
consistent API error shape:

```ts
interface StudioApiError {
  readonly error: {
    readonly code: "UNAUTHORIZED" | "INVALID_REQUEST" | "NOT_FOUND";
    readonly message: string;
  };
}
```

### SSE

`GET /api/events` opens one multiplexed SSE stream for all registered runs.
Each emitted event has this envelope:

```ts
interface StudioStreamEvent {
  readonly cursor: number;
  readonly workflowId: string;
  readonly event: RunnerEvent;
}
```

The SSE `id` is `cursor`. A browser sends `Last-Event-ID` when it reconnects.
Studio replays buffered events with a later cursor, then sends live events.

Studio retains at most 2,048 stream events. It retains at most 100 terminal
run projections. It removes the oldest terminal projection first. Active run
projections remain until their terminal event or Studio shutdown.

If the requested cursor predates the buffer, Studio sends a `stream.reset`
event. The browser then fetches a new snapshot. This reset is normal after a
long disconnect. It is not a runner error.

Studio sends a keepalive comment while the connection is idle. A disconnected
browser has no effect on the run or other browser clients.

## 8. Browser Projection and User Interface

The browser loads the run list snapshot, then connects to the multiplexed SSE
stream. It applies only stream events that follow its snapshot cursor. It uses
the canonical event sequence within each run to reject duplicate or stale
updates.

The page has these read-only regions:

- A run list that shows all current registered runs and their state.
- A graph canvas for the selected run.
- A node inspector for one selected invocation.
- A distinct used-tools list with event counts.
- An event timeline for the selected run.

The graph shows one node per `invocationId`. It shows dependency edges from
`dependencyIds` and containment from `parentInvocationId`. The graph can pan,
zoom, select, and focus. It cannot create, reconnect, move, or delete nodes.

The canvas uses text and an icon with color for every state. It shows queued,
waiting, active, retrying, succeeded, failed, skipped, and cancelled states.
It shows an explicit incomplete-data state when `isIncomplete` is true. Nodes
may show compact duration, token, cost, and input/result-state metadata when
the corresponding event data is available.

The inspector shows input and result sections when their display events exist.
It clearly labels present, redacted, truncated, and omitted values. It formats
present JSON as an expandable value tree. It shows output text separately from
the validated result.

The interface also provides a keyboard-accessible invocation list. This list
is the accessible alternative to the graph canvas. Selecting a node in either
view updates the inspector and the other view's focus state.

Topology changes can add nodes and edges. State or value changes must not
change node placement, viewport position, zoom level, or selected node.

`@xyflow/react` is the V1 graph library. It must run as a non-editable graph
with stable layout and the accessible list alternative. A replacement requires
a new dependency review.

## 9. Required Tests

- Core protocol tests round-trip and reject malformed `planNodeId`, input, and
  result events.
- Runtime tests prove topology maps a Plan node to its invocation and emits
  display values in lifecycle order after the policy runs.
- Policy tests prove unknown values are omitted and redacted values never
  contain raw JSON.
- CLI tests prove a publisher preserves order and a Studio error cannot change
  the renderer output, runner result, or exit status.
- Studio service tests prove registration, event deduplication, event-gap
  state, two parallel runs, terminal records, bounded eviction, and loopback
  rejection.
- SSE tests prove snapshot handoff, reconnect replay, stream reset after
  buffer eviction, and one browser stream that receives two runs.
- Browser tests prove live run-list updates, graph state changes, repeated
  Plan-node invocations, inspector display states, and no editing controls.
- Accessibility tests prove keyboard selection and inspector updates from the
  invocation list.
- Boundary tests prove Studio contracts do not expose Mastra or executor
  fields and packages use public exports only.

## 10. Acceptance Criteria

spec.local-read-only-execution-studio is complete when:

- a user can start one foreground local Studio service and select it for two
  concurrent Seqlane runs;
- the browser lists both runs without polling and can switch between them;
- each selected run shows its live actual invocation graph;
- a graph node maps one runtime invocation to its Plan-node address;
- the inspector shows a present, redacted, truncated, or omitted input/result
  state when the runtime emits that display event;
- browser reconnect restores the current in-memory view or receives a defined
  stream reset;
- a Studio failure or event-forwarding failure leaves the Seqlane run and CLI
  exit status unchanged; and
- no durable history, remote access, editing, run control, Mastra type, or
  executor-specific value is added.

## 11. Explicitly Deferred

- persistent run history, SQLite, browser persistence, exports, and replay
  after a Studio restart;
- remote hosting, remote access, user accounts, and multi-user collaboration;
- run cancellation, retries, approvals, or any browser-to-run command;
- workflow or graph editing;
- historical Plan comparison, work continuation, Git provenance, and artifact
  storage;
- executor transcripts, prompts, sessions, model configuration, and raw
  stdout/stderr;
- browser support for Studio sessions after the foreground service exits.

## 12. Delivery Order

1. Create the private Studio application and foreground session lifecycle.
2. Extend canonical events with Plan-node and display-value data.
3. Build the in-memory registry, ingestion endpoint, snapshots, and SSE.
4. Add best-effort CLI event forwarding.
5. Build the read-only browser projection, graph, inspector, and run list.
6. Document the commands and run complete boundary and accessibility tests.

## 13. Source Decisions

- [adr.local-read-only-execution-studio — Provide a Local Read-Only Execution Studio](../adrs/2026-09-02-local-read-only-execution-studio.md) defines the local read-only Studio decision.
- [adr.dedicated-runner-process — Dedicated Runner Process](../adrs/2026-09-02-dedicated-runner-process.md) defines the runner and CLI ownership boundary.
- [adr.work-run-invocation-identity-model — Work, Run, and Invocation Identity](../adrs/2026-09-02-work-run-invocation-identity-model.md) defines Seqlane execution identity.
- [adr.executor-neutral-workflow-authoring — Executor-Neutral Workflow Authoring](../adrs/2026-09-02-executor-neutral-workflow-authoring.md) defines the executor-neutral boundary.
- [adr.dedicated-seqlane-output-package — Execution Output Package](../adrs/2026-09-02-dedicated-seqlane-output-package.md) defines event projection as a consumer concern.
- [rfc.execution-observability-and-debugging — Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md) defines structured execution inspection and redaction principles.

## Traceability

- [adr.local-read-only-execution-studio](../adrs/2026-09-02-local-read-only-execution-studio.md)
