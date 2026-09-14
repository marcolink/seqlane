# @seqlane/codex-adapter

Private Codex app-server adapter for Seqlane. It owns the local Codex app-server
process, validates its JSONL protocol, and translates completed turns into the
private `AgentAdapter` contract. The runtime selects it through private
`SEQLANE_RUNTIME_ADAPTER_CONFIG` and owns its process for each run.

The tested-version list is advisory. An unconfirmed CLI version emits a
diagnostic and continues; malformed or incompatible protocol messages fail the
adapter.

The transport validates protocol envelopes and the initialize result,
drains child stderr, handles split UTF-8 output, bounds outbound and inbound
JSONL, and confirms child-process termination with forced shutdown escalation.
Turn events are correlated by thread and turn, buffered across the `turn/start`
response, reduced into activity lifecycle events, and bounded by item and
payload limits. Turn cancellation and deadlines attempt interruption and
require terminal confirmation. Unsupported server requests receive typed JSON-
RPC errors.
If interruption cannot be confirmed, the run closes its shared connection and
rejects further session work, checkpoints, and forks. A timed-out model probe
leaves a run-owned connection for the run to close.

## Protocol compatibility probe

Run the live probe only when Codex authentication and an external model call are
approved:

```sh
node --experimental-strip-types scripts/codex-app-server-probe.mjs \
  --workspace "$PWD" \
  --output libs/codex/fixtures/protocol-0.147.0.json
```

The command checks the local CLI version, initialization, model discovery,
typed output, exact checkpoint forks, and interruption of a read-only turn
while an approval request is pending. It validates required protocol envelopes and result
shapes, bounds pending messages by count and bytes, and warns when the CLI
version is not in the tested list. Without `--workspace`, it uses a disposable
temporary workspace. An explicit `--workspace` selects the caller-provided
workspace. It writes only a sanitized observation fixture; generated fixtures
are ignored by version control. The normal test suite uses the deterministic
fake-server test and does not start Codex.
