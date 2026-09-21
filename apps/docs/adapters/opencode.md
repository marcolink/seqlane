# OpenCode

The OpenCode adapter uses OpenCode 1. Seqlane supports OpenCode 1.18.27.
OpenCode 2 is not yet supported.

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

OpenCode supports model selection, structured output, session reuse, checkpoint
branches, and activity events. It exposes a session UI only if the server
provides a browser URL.

The OpenCode service remains responsible for its tools, filesystem access,
network access, skills, and approvals. Seqlane does not change those settings.
