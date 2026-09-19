# OpenCode

The OpenCode adapter starts and closes a private OpenCode 1 service for each
run. Seqlane supports OpenCode 1.18.27. OpenCode 2 is not yet supported.

It uses a loopback host and an ephemeral port by default. Use `--adapter-host`
or `--adapter-port` only when you need a specific loopback endpoint.

Run the workflow:

```sh
seqlane run ./workflow.ts --input '{}' --adapter opencode --workspace .
```

OpenCode supports model selection, structured output, session reuse, checkpoint
branches, and activity events. It exposes a session UI only if the server
provides a browser URL.

The OpenCode service remains responsible for its tools, filesystem access,
network access, skills, and approvals. Seqlane does not change those settings.
