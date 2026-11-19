# OpenCode 2

Select `opencode-v2` for OpenCode 2. The adapter uses `@opencode/client` and
checks server compatibility before agent work starts. The `opencode` adapter
continues to use OpenCode 1.

## Managed service

Install OpenCode 2 separately. Seqlane does not install or upgrade OpenCode.
Both major versions use the `opencode` command. Use an absolute executable path
when both versions are installed.

```sh
seqlane run ./workflow.ts \
  --adapter opencode-v2 \
  --opencode-v2-executable /absolute/path/to/opencode \
  --workspace ./repository
```

Without the executable flag, Seqlane resolves `opencode` from `PATH`.
Managed mode starts one private foreground service on macOS or Linux. It uses
loopback host `127.0.0.1`, an ephemeral port, and a generated Basic credential.
The run closes its sessions and process tree when it ends.

Use `--opencode-v2-host` and `--opencode-v2-port` to change the loopback endpoint.
Port `0` selects an ephemeral port. Managed mode never selects a shared native
service.

Managed runs inherit runtime paths and locale settings. Other variables require
explicit selection. If a provider uses an environment credential, list its
variable name in `SEQLANE_OPENCODE_V2_ENV` before the run:

```sh
export SEQLANE_OPENCODE_V2_ENV=OPENAI_API_KEY
```

The list accepts at most 128 comma-separated names and no wildcards. Select only
variables that the provider or service needs. Selected values and the generated
server password remain available to native tools. Credential files remain
accessible through the native configuration directories.

## External service

Set the same `OPENCODE_SERVER_PASSWORD` for the native service and Seqlane.
The native Basic username is `opencode`. Omit the variable only for a service
that requires no password.

```sh
seqlane run ./workflow.ts \
  --adapter opencode-v2 \
  --opencode-v2-mode external \
  --opencode-v2-host 127.0.0.1 \
  --opencode-v2-port 4096 \
  --workspace ./repository
```

External mode requires an explicit loopback host and port from `1` through
`65535`. It does not accept an executable flag. The run removes only its own
session tree and owned background shells. It keeps the external service running.

V2 flags require `--adapter opencode-v2`. The existing `--opencode-*` flags apply
to `--adapter opencode`.

## Models and sessions

Native OpenCode configuration controls tools, providers, authentication, skills,
and permissions. Configure these before a non-interactive run. Pending
permissions and forms fail the task. Seqlane never answers them.

Authored provider, model, and reasoning selections must exist in the native
catalog. The model must support tools. Ordered session reuse preserves the
native session and model. Responses from another provider or model fail the
task. Failed sessions cannot be reused.

Checkpoint, fork, and session UI are unavailable. A workflow that requires an
unsupported capability fails before that agent work starts.

## Results and activity

The adapter requests one JSON value and validates it with the task output
schema. Invalid output fails without a repair prompt or task replay.

Finite message reads correlate completion with the admitted input. Parent idle
is insufficient while owned child sessions or background shells remain active.
Cancellation interrupts owned sessions, removes owned shells, and checks their
termination. Unconfirmed cleanup fails the run.

Activity and assistant usage map to Seqlane events. Usage belongs to the current
invocation, including reused sessions. The adapter waits one second between
status polls, so polling can combine rapid intermediate updates. It does not
provide token streaming or a native transcript view.

Deterministic and dry runs start no service and make no model calls.
