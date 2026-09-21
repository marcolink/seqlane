# OpenCode

The OpenCode adapter uses OpenCode 1. Seqlane supports OpenCode 1.18.27.
OpenCode 2 is not yet supported.

By default, `seqlane run` starts and closes a private service. This managed
mode uses `127.0.0.1` and an ephemeral port.

Use `--opencode-mode external` to connect to an existing service. You must set
`--opencode-host` and `--opencode-port`. The host must be loopback. The port
must be from `1` through `65535`. Seqlane never starts or stops an external
service.

Run the workflow:

```sh
seqlane run ./workflow.ts --input '{}' --adapter opencode --workspace .
```

OpenCode supports model selection, structured output, session reuse, checkpoint
branches, and activity events. It exposes a session UI only if the server
provides a browser URL.

The OpenCode service remains responsible for its tools, filesystem access,
network access, skills, and approvals. Seqlane does not change those settings.
