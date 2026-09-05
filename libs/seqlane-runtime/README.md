# @seqlane/runtime

Private runtime boundary for compiling and executing Seqlane Plans. Effect is
private infrastructure; its types do not cross this package boundary.

### Community Mastra dependency boundary

The runtime pins `@mastra/core@1.64.0`. The private integration registers and
runs workflows through the workflow API from `@mastra/core/workflows`, using
`createStep` and `createWorkflow`. The package declares
Apache-2.0 licensing. Mastra paths under `ee/` are enterprise-only and are
rejected by the runtime boundary tests.

The Enterprise boundary guard scans production source and package manifests in
`apps/` and `libs/`. It rejects static and side-effect imports, export-from
declarations, `require` calls, and dynamic imports of `ee/` paths. The runtime
validates task inputs and outputs, resolves bindings, emits bounded consumer
events, and retains results until their final consumer completes.

The Mastra compiler currently rejects repeat nodes until a dedicated
Mastra-native repeat lowering is added.

Each private Mastra runtime accepts one workflow run. Reusable workflow
registrations expose MCP through fresh per-invocation runtimes. A compiled
one-shot Plan runtime does not expose its run-bound workflow through MCP. Its
in-memory storage remains available for inspection while the execution owns
that runtime.

### Local task execution

A task with `execute` runs through the local invocation path. The runtime parses
its typed input and provides a scoped `TaskContext.exec` capability. Each call
uses a Mastra `LocalSandbox` process with an executable and direct argv, never a
shell, and captures bounded stdout and stderr. Results include Seqlane task and
invocation identity, timing, truncation, timeout, and cancellation metadata.

Local tasks do not resolve an agent executor, model, session, or checkpoint, and
their generic invocation results contain no model or token metrics. V1 is
non-interactive and requires `execute` to await `exec`; there is no Git helper,
Git mutation API, shell support, background-process API, or command policy.

Workspace policy is scheduling-only. A task with `workspace: "shared"` may run
with other shared tasks. An `exclusive` task waits for all workspace work; any
task waits while an exclusive task is active. Omitted policy resolves to
`exclusive`. Workspace policy neither grants nor restricts filesystem, shell,
network, MCP, skill, or custom-tool access.

Top-level Plan tasks rely on graph dependencies for statically known workspace
constraints and do not acquire a redundant runtime workspace lease. Dynamically
created work, including repeat-body tasks and direct invocation calls, still
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

The selected runtime owns its permissions and approval behavior. Seqlane never
inspects or changes runtime permission configuration. An unsupported runtime
interaction during a non-interactive Run becomes a deterministic executor
failure; Seqlane never approves it.

Seqlane coordinates only sessions and processes it starts or tracks. It does
not roll back mutations or guarantee behavior of unmanaged external processes.
