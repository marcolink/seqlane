# @seqlane/runtime

Private runtime boundary for compiling and executing Seqlane Plans. Effect is
private infrastructure; its types do not cross this package boundary.

The runtime validates task inputs and outputs, resolves bindings, emits bounded
consumer events, and retains results until their final consumer completes.

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
or a parent continuation can run. A fan-in task consumes branch outputs as
normal input and explicitly selects one session; Seqlane never merges
diverged histories. Failed or ambiguous turns publish no checkpoint and poison
their session.

The selected runtime owns its permissions and approval behavior. Seqlane never
inspects or changes runtime permission configuration. An unsupported runtime
interaction during a non-interactive Run becomes a deterministic executor
failure; Seqlane never approves it.

Seqlane coordinates only sessions and processes it starts or tracks. It does
not roll back mutations or guarantee behavior of unmanaged external processes.
