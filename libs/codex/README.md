# @seqlane/codex-adapter

Private Codex app-server adapter for Seqlane. It owns the local Codex app-server
process, validates its JSONL protocol, and translates completed turns into the
private `AgentAdapter` contract. Runtime registration is intentionally owned by
the later runtime integration task.

The tested-version list is advisory. An unconfirmed CLI version emits a
diagnostic and continues; malformed or incompatible protocol messages fail the
adapter.

The transport requires JSON-RPC 2.0 envelopes, validates the initialize result,
drains child stderr, handles split UTF-8 output, bounds outbound and inbound
JSONL, and confirms child-process termination with forced shutdown escalation.
Turn events are correlated by thread and turn, buffered across the `turn/start`
response, reduced into activity lifecycle events, and bounded by item and
payload limits. Cancellation and request/turn deadlines interrupt the turn and
require terminal confirmation. Unsupported server requests receive typed JSON-
RPC errors.

## Protocol compatibility probe

Run the live probe only when Codex authentication and an external model call are
approved:

```sh
node scripts/codex-app-server-probe.mjs \
  --workspace "$PWD" \
  --output libs/codex/fixtures/protocol-0.147.0.json
```

The command checks the local CLI version, initialization, model discovery,
typed output, exact checkpoint forks, interruption, and approval interruption.
It writes only a sanitized observation fixture. The normal test suite uses the
deterministic fake-server test and does not start Codex.
