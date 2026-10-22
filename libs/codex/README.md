# @seqlane/codex-adapter

Internal Codex app-server adapter for Seqlane. This package is public on npm so
`seqlane` can install it. Its exports are not a supported API. It owns the local
Codex app-server process, validates its JSONL protocol, and translates completed
turns into the internal `AgentAdapter` contract. The runtime selects it through internal
`SEQLANE_RUNTIME_ADAPTER_CONFIG` and owns its process for each run.
Effect scopes own the shared run connection and each child-process lifetime.

`executable` is optional. When omitted, the runtime resolves `codex` from
`PATH`. A configured absolute path is preferred; if it is unavailable, the
runtime falls back to `PATH` and emits a warning. If no candidate is usable, the
runtime reports a stable not-found error with remediation guidance. After a
candidate is selected, startup, version, and protocol failures are terminal and
do not trigger another candidate lookup.

On POSIX, empty `PATH` entries are ignored. The adapter never treats them as
the current directory because it must not discover an executable from an
implicit workspace path.

The tested-version list is advisory. An unconfirmed CLI version emits a
diagnostic and continues; malformed or incompatible protocol messages fail the
adapter.

The transport validates protocol envelopes and the initialize result,
drains child stderr, handles split UTF-8 output, and bounds outbound and inbound
JSONL. On POSIX, the default app-server runs in its own process group.
Shutdown rechecks its birth identity before sending signals to the group.
Shutdown escalates from SIGTERM to SIGKILL. Termination requires the child
close event and confirmed group shutdown. If the leader identity is lost while
descendants remain, shutdown reports uncertainty after the bounded deadline.
Turn events are correlated by thread and turn, buffered across the `turn/start`
response, reduced into activity lifecycle events, and bounded by item and
payload limits. Turn cancellation and deadlines attempt interruption and
require terminal confirmation. Unsupported server requests receive typed JSON-
RPC errors.

Activity has a separate budget of 65,536 events or 8,000,000 payload bytes per
turn. At either limit, the adapter clears retained activity records and emits
one progress notice with `metadata: { truncated: true }`. It omits further
activity, but continues to collect the final result. Individual message limits,
completed-item limits, task deadlines, cancellation, and approval handling still
apply.

If interruption cannot be confirmed, the run closes its shared connection and
rejects further session work, checkpoints, and forks. A timed-out model probe
leaves a run-owned connection for the run to close.

Each Codex model turn emits one canonical model observation with the complete
request, response items, available token usage, turn identity, and timing.
Codex does not expose a verified cost value, so the observation marks cost as
unavailable. Tool activity retains its native ID, name, input, and timestamps.
An open activity ends as failed only after turn interruption or process
termination is confirmed; no output is added when the server did not provide it.

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
