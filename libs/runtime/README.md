# @seqlane/runtime

Private runtime boundary for compiling and executing Seqlane Plans. Runtime
implementation details and types do not cross this package boundary.

### Community Mastra dependency boundary

The runtime pins `@mastra/core@1.64.0`. The installed Community package exposes
the workflow API from `@mastra/core/workflows`, including `createStep` and
`createWorkflow`, which the private integration uses to register and run
workflows. The package declares Apache-2.0 licensing. Mastra paths under `ee/`
are enterprise-only and are rejected by the runtime boundary tests.

The Enterprise boundary guard scans production source and package manifests in
`apps/` and `libs/`. It rejects static and side-effect imports, export-from
declarations, `require` calls, and dynamic imports of `ee/` paths. The runtime
validates task inputs and outputs, resolves bindings, emits bounded consumer
events, and retains results until their final consumer completes.

The Mastra compiler lowers `.task().until()` to a native post-condition loop.
It checks the condition after each attempt and enforces both the declared
iteration limit and the shared run repeat budget. Repeat attempts can invoke
tasks or child workflows.

Each private Mastra runtime accepts one workflow run. Reusable workflow
registrations expose MCP through fresh per-invocation runtimes. A compiled
one-shot Plan runtime does not expose its run-bound workflow through MCP. Its
dispatcher applies bounded concurrency and a per-invocation deadline. Its
in-memory storage remains available for inspection while the execution owns
that runtime. Cancelled queued MCP invocations are removed immediately so
they do not consume queue capacity. A deadline settles the caller and
releases dispatcher capacity even if workflow code ignores cancellation.
Server and discovery helpers receive the caller's `RequestContext` and
`AbortSignal`; they do not synthesize a separate request context.

### Task execution and invocation policy

Every task definition exposes one `execute({ input, signal, context })` contract.
The runtime parses its typed input, admits the invocation's workspace policy,
and provides a scoped `TaskContext`. `context.exec` runs an executable with
direct argv through a Mastra `LocalSandbox` (never through a shell), with
bounded stdout and stderr. A nonzero process exit code is task output; spawn,
timeout, cancellation, and output-limit failures reject the invocation. The
canonical process result is `{ exitCode, stdout, stderr }`; richer process
metadata remains private runtime detail. `context.runAgent` uses the executor
selected by the invocation's session policy.

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

Top-level Plan tasks rely on graph dependencies for statically known workspace
constraints and do not acquire a redundant runtime workspace lease. Dynamically
created work, including repeat attempts and direct invocation calls, still
uses atomic session and workspace admission. A waiting dynamic invocation
retains neither resource. Seqlane holds its leases through executor requests,
tracked children, processes, cancellation, and cleanup. Queue order uses
invocation creation order. Events report workspace waiting, admission, and
release.

After a successful agent turn and all tracked activity, the runtime publishes
its private checkpoint. `reuse()` keeps the source session; `branch()` eagerly
materializes every declared child from that checkpoint before either children
or a parent continuation can run. Native checkpoint forks are created one at a
time; child task execution can still overlap after all sessions are
materialized. A fan-in task consumes branch outputs as normal input and
explicitly selects one session; Seqlane never merges diverged histories.
Failed or ambiguous turns publish no checkpoint and poison their session.

Model selection is resolved before execution. A new session may select a
model; omitted selection uses the configured OpenCode default. Reuse inherits
the pinned selection, while a branch may pin a different selection. Seqlane
does not fall back after validation. Completion events expose the effective
provider, model, and optional reasoning as Seqlane-owned metrics.

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

Codex app-server is selected only through the private
`SEQLANE_RUNTIME_ADAPTER_CONFIG` environment value. Its strict configuration
uses an absolute executable path and optional `networkAccess` boolean:

```json
{
  "adapter": "codex",
  "executable": "/absolute/path/to/codex",
  "networkAccess": false
}
```

The runtime supplies the workspace, validates Codex models before task work,
and closes each run-owned app-server process at run completion. Codex is not
available through workflow source, Plans, or public CLI flags.

Seqlane coordinates only sessions and processes it starts or tracks. It does
not roll back mutations or guarantee behavior of unmanaged external processes.
