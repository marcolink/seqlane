# OpenCode

`--adapter opencode` detects the native version and selects the matching
implementation. Seqlane tests OpenCode 1.18.27 and OpenCode 2.1.2.

Managed mode reads `opencode --version` before service startup. It selects
the binary on `PATH`, or the absolute path from `--opencode-executable`.
External mode reads server information before session creation. Detection
accepts stable OpenCode 1 versions and OpenCode 2.1.2. OpenCode 1 keeps its
version-aware output compatibility policy. Unsupported or malformed versions
stop the run. Authentication and transport errors stop detection.

## Setup

Install and configure OpenCode separately. Seqlane does not install or upgrade
OpenCode. Both major versions use the `opencode` command.
When both versions are installed, use an absolute executable path to select one:

```sh
seqlane run ./workflow.ts \
  --adapter opencode \
  --opencode-executable /absolute/path/to/opencode \
  --workspace ./repository
```

Without the executable flag, Seqlane resolves `opencode` from `PATH`.
Native OpenCode configuration controls tools, providers, authentication, skills,
permissions, filesystem access, and network access. Configure these before a
non-interactive run. Seqlane does not change those settings.

## Modes

### Managed mode

By default, `seqlane run` starts and closes a private service. This mode uses
`127.0.0.1` and an ephemeral port.

Run the workflow:

```sh
seqlane run ./workflow.ts \
  --input '{}' \
  --adapter opencode \
  --workspace .
```

Use `--opencode-host` and `--opencode-port` to change the loopback endpoint.
Port `0` selects an ephemeral port.

#### OpenCode 2 environment

OpenCode 2 managed mode supports macOS and Linux. It starts a private foreground
service with a generated Basic credential. The run closes its sessions and
process tree when it ends.

Managed runs inherit runtime paths and locale settings. Other variables require
explicit selection. If a provider uses an environment credential, list its
variable name in `SEQLANE_OPENCODE_V2_ENV` before the run:

```sh
export SEQLANE_OPENCODE_V2_ENV=OPENAI_API_KEY
```

The list accepts at most 128 comma-separated names and no wildcards. Select only
variables that the provider or service needs. Selected provider values remain
available to native tools. Managed mode removes the server password from the
environment before native tools start. Seqlane keeps authenticated client access.
Credential files remain accessible through the native configuration directories.

### External mode

Use `--opencode-mode external` to connect to an existing service. The host must
be loopback. The port must be from `1` through `65535`. Seqlane never starts or
stops an external service.

For an authenticated external service, set `OPENCODE_SERVER_PASSWORD` to the
native password. The default Basic username is `opencode`.
If the service uses a different username, set `OPENCODE_SERVER_USERNAME`.
Omit the password variable only for a service that requires no password.
External mode does not accept an executable flag.

::: warning Prerequisite

Before you use external mode, start an OpenCode server:

```sh
opencode serve \
  --port 4096
```

:::

Run the workflow:

```sh
seqlane run ./workflow.ts \
  --input '{}' \
  --adapter opencode \
  --opencode-mode external \
  --opencode-host 127.0.0.1 \
  --opencode-port 4096 \
  --workspace .
```

With OpenCode 2, the run removes only its own session tree and owned background
shells. It keeps the external service running.

## Capabilities

The detected version determines the available capabilities.

| Capability | OpenCode 1 | OpenCode 2 |
| --- | --- | --- |
| Model selection | Yes | Yes |
| Structured output | Yes | Yes |
| Session reuse | Yes | Yes |
| Checkpoint and fork | Yes | Yes |
| Activity and usage | Yes | Yes |
| Interactive questions | No | Text and single choice |
| Session UI | When the server provides a browser URL | No |

A workflow that requires an unsupported capability fails before that agent
work starts. Deterministic and dry runs start no service and make no model calls.

### OpenCode 2 models and sessions

Pending permissions fail the task. Seqlane never approves them.
Enable `--interactive` to answer native questions in the same invocation.
The native `question` tool supports text and single-choice questions, including
custom text alternatives. Optional fields, multiselect questions, and arbitrary
native forms fail.
Without interactivity, pending questions fail the task. Input cancellation or
timeout cancels the native form before Seqlane stops owned work.
Read [Interactivity](/interactivity) for terminal requirements and deadlines.

Authored provider, model, and reasoning selections must exist in the native
catalog. The model must support tools. Ordered session reuse preserves the
native session and model. Responses from another provider, model, or reasoning
variant fail the task. If a response omits a selected variant, the task fails.
Failed sessions cannot be reused.

Checkpoints and forks preserve a completed task's history and instructions.
Later reuse of the source does not change that checkpoint. Parallel forks use
independent sessions. Cancelling one fork preserves its source and peers.
A fork can select another model or reasoning level before agent work starts.
Capture and fork make no model calls. The run removes retained snapshots when
it ends. Session UI remains unavailable.

### OpenCode 2 results and activity

The adapter requests one JSON value and validates it with the task output
schema. Invalid output fails without a repair prompt or task replay.

The prompt includes task input under `Task input:`. Input must be a JSON value
whose serialized form is at most 1 MiB in UTF-8. Non-JSON values and oversized
input fail before native session creation.

Completion requires owned child sessions and background shells to finish.
Cancellation interrupts owned sessions, removes owned shells, and checks their
termination. Unconfirmed cleanup fails the run.

Activity and assistant usage map to Seqlane events. Usage belongs to the current
invocation, including reused sessions. Each started tool activity receives a
terminal event. Unfinished activities end as failed when observation stops,
including cancellation. Native cleanup still requires termination proof.
Tool activity includes input, output, and metadata. Changes during execution
produce progress notifications. Terminal events retain the complete latest
details. Model observations include available reasoning and tool content.
Credential redaction applies to nested values as well as text.
Tool values have a depth limit of 64 and a node limit of 65,536.

The adapter waits one second between status polls, so polling can combine rapid
intermediate updates. It does not provide token streaming or a native transcript view.

## Explicit OpenCode 2 selection

Use `--adapter opencode-v2` to explicitly require OpenCode 2.1.2. Its
`--opencode-v2-*` flags require that selector. Automatic detection uses
`--adapter opencode` with the shared `--opencode-*` flags.
Read the [CLI flag reference](/cli/run#explicit-opencode-2-flags) for details.
