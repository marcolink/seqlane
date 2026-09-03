# @seqlane/runtime

Private runtime boundary for compiling and executing Seqlane Plans. Effect is
private infrastructure; its types do not cross this package boundary.

### Community Mastra dependency boundary

The runtime pins `@mastra/core@1.64.0`. The installed package exposes the
workflow API from `@mastra/core/workflows`, including `createStep` and
`createWorkflow`, for the next migration slice. The package declares
Apache-2.0 licensing. Mastra paths under `ee/` are enterprise-only and are
rejected by the runtime boundary tests.

The runtime validates task inputs and outputs, resolves bindings, emits bounded
consumer events, and retains results until their final consumer completes.

### Local task execution

A task with `execute` runs through the local invocation path. The runtime parses
its typed input, admits the canonical workspace, and provides a scoped
`TaskContext.exec` capability. Each call starts one foreground process with an
executable and direct argv, never a shell, and captures bounded stdout and
stderr. The workspace lease remains held until the process terminates.

Local tasks do not resolve an agent executor, model, session, or checkpoint, and
their generic invocation results contain no model or token metrics. V1 is
non-interactive and requires `execute` to await `exec`; there is no Git helper,
Git mutation API, shell support, background-process API, or command policy.

Workspace policy is scheduling-only. A task with `workspace: "shared"` may run
with other shared tasks. An `exclusive` task waits for all workspace work; any
task waits while an exclusive task is active. Omitted policy resolves to
`exclusive`. Workspace policy neither grants nor restricts filesystem, shell,
network, MCP, skill, or custom-tool access.

Admission requires completed dependencies, an available executor session, a
compatible workspace policy, and global capacity. Session and workspace leases
are admitted atomically: a waiting invocation retains neither resource.
Seqlane holds both leases through executor requests, retries, tracked children,
processes, cancellation, and cleanup. Queue order uses invocation creation
order. Events report workspace waiting, admission, and release.

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
