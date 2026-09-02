# TS-020 Implementation Stories

The capability-enforcement stories were retired. ADR-020 now uses workspace
policy only: `shared` permits shared overlap; `exclusive` serializes workspace
admission. Runtime configuration, not Seqlane, owns executor authority.

The retained stories cover DAG dependencies, session serialization, workspace
resource identity, admission lifetime, deterministic queues, cancellation, and
tracked child/process lifetime. See [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
for the implemented contract.
