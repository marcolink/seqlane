# @seqlane/codex-adapter

Private Codex app-server adapter for Seqlane. It owns the local Codex app-server
process, validates its JSONL protocol, and translates completed turns into the
private `AgentAdapter` contract. Runtime registration is intentionally owned by
the later runtime integration task.

The tested-version list is advisory. An unconfirmed CLI version emits a
diagnostic and continues; malformed or incompatible protocol messages fail the
adapter.

The transport requires JSON-RPC 2.0 envelopes, validates the initialize result,
drains child stderr, and confirms child-process termination before resolving its
termination promise. Turn events are correlated by thread and turn, buffered
across the `turn/start` response, reduced into activity lifecycle events, and
bounded by item and payload limits. Cancellation and turn deadlines interrupt
the turn and require terminal confirmation.
