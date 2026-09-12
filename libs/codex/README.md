# @seqlane/codex-adapter

Private Codex app-server adapter for Seqlane. It owns the local Codex app-server
process, validates its JSONL protocol, and translates completed turns into the
private `AgentAdapter` contract. Runtime registration is intentionally owned by
the later runtime integration task.

The tested-version list is advisory. An unconfirmed CLI version emits a
diagnostic and continues; malformed or incompatible protocol messages fail the
adapter.
