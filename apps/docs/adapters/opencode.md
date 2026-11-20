# OpenCode

`--adapter opencode` detects the native version and selects the matching
implementation. Seqlane tests OpenCode 1.18.27 and OpenCode 2.1.2.
The `@seqlane/opencode-adapter` package contains both versions.
Its root export uses OpenCode 1. Its `/v2` export uses
[OpenCode 2](/adapters/opencode-v2).

Managed mode reads `opencode --version` before service startup. It selects
the binary on `PATH`, or the absolute path from `--opencode-executable`.
External mode reads server information before session creation. Detection
accepts stable OpenCode 1 versions and OpenCode 2.1.2. V1 keeps its existing
version-aware output compatibility policy. Unsupported or malformed versions
stop the run. Authentication and transport errors stop detection.

Seqlane does not install or upgrade OpenCode. When both versions are installed,
use an explicit executable path to select one. The detected version determines
capabilities. OpenCode 2 lacks checkpoint, fork, and session UI support.

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

### External mode

Use `--opencode-mode external` to connect to an existing service. The host must
be loopback. The port must be from `1` through `65535`. Seqlane never starts or
stops an external service.

For an authenticated external service, set `OPENCODE_SERVER_PASSWORD` to the
native password. The default Basic username is `opencode`. Set
`OPENCODE_SERVER_USERNAME` when the service uses a different username.

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

OpenCode 1 supports model selection, structured output, session reuse, checkpoint
forks, and activity events. It exposes a session UI only if the server
provides a browser URL.

The OpenCode service remains responsible for its tools, filesystem access,
network access, skills, and approvals. Seqlane does not change those settings.
