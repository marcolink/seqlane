# @seqlane/runtime

Internal Effect v4 runtime boundary for compiling and executing Seqlane Plans.
This package is public on npm so `seqlane` can install it. Its exports are not
a supported API.

Release tarballs contain production code and declarations. Private test support,
crash fixtures, and compiler test output stay in the development checkout.

CLI, direct, HTTP, and MCP callers use the same private Effect Plan program.
Public authoring and wire contracts remain Zod-owned. Concrete adapters are
created by application composition and stay outside this package.

### Hosted execution and inspection

The optional operational host uses Effect HTTP, MCP, and SQL services. It keeps
versioned run metadata, outcomes, canonical events, observations, and correlated
native spans in a fresh `.seqlane/operations.db`. Standalone runs create no
listener or history database. Existing databases are not imported or removed.
Each history database has one host owner. SQLite holds its connection lock
until that host closes or exits; concurrent callers use the host API.

The host composes scoped run-manager and SQLite services in one managed
runtime. Private service methods return Effects. Run fibers, completion, and
shutdown waits inherit the caller context. The host exposes Promise methods
and acquires its listener only on `listen()`; `fetch()` works without listening.

HTTP start returns a run reference immediately. Status, result, ordered event
pages, bounded run lists, cancellation, and trace inspection share the same run
identity. Accepted history must flush before terminal inspection is complete.
Storage failures and omitted inspection records are explicit. A completed task
outcome stays separate from inspection completeness.

After restart, unfinished runs become interrupted. The host never repeats their
external actions. MCP uses the same admitted run program and cancellation path.
A cancelled or timed-out request must drain its run before its capacity is
released. The native MCP integration is isolated because the pinned API is
unstable.

### Observations and telemetry

Canonical observations retain complete available model, tool, skill, request,
response, usage, cost, timing, availability, and correlation values. One
acknowledged, byte-bounded sink preserves accepted event order. Bounded terminal
retention evicts whole records with a visible notice; it does not shorten values.

Effect owns native spans, metrics, logs, and optional OTLP export. Observations
provide the detailed projection without a second adapter trace tree. Remote
export requires explicit `SEQLANE_TELEMETRY` configuration and a payload policy.
Exporter failure cannot change a task result. Required event delivery failure
remains an execution failure.

The private `exportTelemetryEffect` composes into the hosted manager and CLI
programs. Export inherits their native clock and scope; each execution owns its
failure counters. Native JSON serialization and scoped HTTP retain byte-bounded
batches, 64 KiB acknowledgements, rejection checks, and one total shutdown deadline.
The pinned Effect 4.0.5 `OtlpExporter` uses item-count batches, reads complete
response buffers, retries transport errors, and hides export failures. Its flusher
waits only for exports it starts. These gaps require the bounded export boundary.

### Classifier transport

Classifier calls use scoped Effect HTTP streams and one native timeout across
all attempts and retry waits. Raw response bytes have a 1 MiB limit. Strict
UTF-8 decoding rejects incomplete characters at EOF. The monotonic budget check
also rejects success after synchronous observation delivery exhausts the budget.

The Effect 4.0.5 TypeSafe client parses only declared response fields and does
not return the complete raw provider response. Its decision model rescales
rounded probabilities and derives rating labels. The existing Zod boundary
retains provider extensions, exact scores, choices, legends, and probabilities.
These compatibility gaps prevent replacing it with that client. Native
`Stream.decodeText` also lacks fatal UTF-8 decoding and final decoder flushing.

### Task execution and invocation policy

Every task definition exposes one `execute({ input, signal, context })` contract.
Runnable input has one owning schema parse per invocation. Ordinary tasks and
selected choice arms pass prepared input from the compiler to the kernel.
Direct calls and repeat tasks prepare raw input in the kernel. Child workflows
reuse prepared input or validate raw input at their workflow boundary. Schema
transforms reach the runnable without a second parse. Output validators share
one check/gate implementation; each caller retains its validation timing.
Selected choice arms with invalid input emit failure without a start event.
They acquire no session or workspace admission and never execute a fallback.

The runtime parses its typed input, admits the invocation's workspace policy,
and provides a scoped `TaskContext`. `context.exec` runs an executable with
direct argv through Effect's Node child-process service (never through a
shell), with bounded stdout and stderr. A nonzero process exit code is task
output; spawn, timeout, cancellation, and output-limit failures reject the
invocation. On POSIX, process-group termination is confirmed before the task
settles. The canonical process result is `{ exitCode, stdout, stderr }`;
richer process metadata remains private runtime detail. `context.runAgent` uses
the executor selected by the invocation's session policy.

The private Effect Plan program runs each ready task as soon as its dependencies
settle. Dependency waiters do not hold task-body permits; the shared program
uses a bound of eight active task bodies. It waits for started work to settle
before reporting failure or cancellation. Task input is validated before
admission or `invocation.started`. Invalid input emits `invocation.failed`
without starting the task body. CLI, direct, and hosted callers all use this program.

After executor execution settles, interruption starts, or an executor reports
uncertainty, the runtime allows up to 30 seconds for tracked work to settle.
This is a cleanup bound, not a task deadline. If termination is unconfirmed,
the runtime fails the invocation
and quarantines its session and workspace. A late executor failure is retained
as the uncertainty error's cause. The affected lease stays held while the run's
admission registry remains alive.

The shared program supports nested workflows, selected choice arms, bounded
repeats, next-input bindings, and output validation. Nested graphs share the
task-body limit, repeat budget, admission registries, and invocation creation
order. Containers do not hold a task-body permit while waiting for children.
Each attempt has its own invocation identity. Unselected arms do not parse
input, acquire sessions, or execute validators.

Workflow containers reserve their resources atomically. Each resource uses the
strongest policy required by the container and its possible descendants.
Distinct child owners carry explicit ancestor identities, so containment does
not allow exclusive siblings to overlap. Fully shared subtrees can overlap.
Waiting containers hold no partial reservation.

Native output validation runs after the execution workspace and body permit are
released. The session remains held through validation and checkpoint capture.
Validation must pass before invocation success. Result bindings preserve the
whole domain value, including objects with an `output` field and false-like
values. Private result markers never enter Plans, events, or wire payloads.

Every `context.exec` call has a 30-second default timeout and a five-minute
maximum timeout. On cancellation, the runtime waits for a bounded cleanup
period, escalates process-group termination when needed, and quarantines the
invocation when it cannot confirm termination.

Workspace and session policies belong to task invocations and Plan nodes, not
task definitions. A task without a declared session uses a registered executor
as an isolated one-shot adapter execution; it does not resolve or allocate a
session from inside `execute`. A declared session is resolved and admitted
before task execution, and only those invocations can publish or consume a
session checkpoint. V1 is non-interactive and requires `execute` to await
`exec`; there is no Git helper, Git mutation API, shell support,
background-process API, or command policy.

Workspace policy is scheduling-only. An invocation with `workspace: "shared"` may run
with other shared tasks. An `exclusive` task waits for all workspace work; any
task waits while an exclusive task is active. Omitted policy resolves to
`exclusive`. Workspace policy neither grants nor restricts filesystem, shell,
network, MCP, skill, or custom-tool access.

The native Effect Plan compiler uses atomic session and workspace admission
for every task, including top-level Plan tasks. Waiting tasks retain neither
resource, and workspace eligibility does not consume a task-body permit.
Immutable `TxRef` values hold private admission state. One transaction checks
and acquires every workspace and session. Native transactional retry wakes
blocked fibers. Scope cleanup removes cancelled demand and undelivered leases.
Waiting observations run outside transactions. Existing synchronous lease
callbacks evaluate only pure admission transactions.

Seqlane holds its leases through executor requests, tracked children, processes,
cancellation, and cleanup. Eligible waiters follow invocation creation order.
A workspace waiter does not reserve its session against eligible work in another
workspace. Events report workspace waiting, admission, and release.

After a successful agent turn and all tracked activity, the runtime publishes
its private checkpoint. `reuse()` keeps the source session; `fork()` creates a
separate child session from that checkpoint. Unconditional forks materialize
before a parent continuation can advance. Choice-arm forks materialize only
when selected, using the captured checkpoint. Native checkpoint forks are created one at a time;
child task execution can overlap after session materialization. A fan-in task
consumes fork outputs as normal input and explicitly selects one session;
Seqlane never merges diverged histories. Failed or ambiguous turns publish no
checkpoint and poison their session.

Hosted model selection is resolved before execution. A new session may select a
model; omitted selection uses the workflow default, then the configured adapter default. Reuse inherits
the pinned selection, while a fork may pin a different selection. Seqlane
does not fall back after validation. Completion events expose the effective
provider, model, and optional reasoning as Seqlane-owned metrics.

Standalone preparation provides a lazy, run-owned adapter lease. The caller
supplies the selected agent runtime; concrete adapter packages own service
startup, configuration validation, and shutdown. Standalone model checks
require a workflow or session selection and never use an adapter default.
The CLI composes these resources before executing the common run program.

Agent invocation metrics cover every completed model response in that
invocation, including structured-output repair responses. Duration, cost, and
available token counters are aggregated. If observed responses use different
models or providers, the aggregate omits those observed identities; the
effective configured selection remains in `modelSelection`. Persistent task
output retains observed metrics when a paid invocation fails or is cancelled.

The selected runtime owns its permissions and approval behavior. Seqlane never
inspects or changes runtime permission configuration. An unsupported runtime
interaction during a non-interactive Run becomes a deterministic executor
failure; Seqlane never approves it.

Application composition selects Codex through its private configuration. Its
strict configuration accepts an optional absolute executable path and optional
`networkAccess` boolean:

```json
{
  "adapter": "codex",
  "networkAccess": false
}
```

When `executable` is omitted, the Codex adapter resolves `codex` from `PATH`.
A configured path is preferred; when unavailable, the adapter falls back to
`PATH` and emits a diagnostic.

The selected agent runtime receives the workspace, validates Codex models before
task work, and closes each run-owned app-server process at run completion.
The standalone CLI selects it with `--adapter codex`. Connection details remain
private and do not enter workflow source or Plans.

Seqlane coordinates only sessions and processes it starts or tracks. It does
not roll back mutations or guarantee behavior of unmanaged external processes.
