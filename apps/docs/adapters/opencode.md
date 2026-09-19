# OpenCode

The OpenCode adapter connects to a running OpenCode 1 server. Seqlane supports
OpenCode 1.18.27. OpenCode 2 is not yet supported.

::: warning Required

Start an OpenCode server before you run a workflow:

```sh
opencode serve --port 4096
```

:::

Then run the workflow:

```sh
seqlane run ./workflow.ts --input '{}' --adapter opencode \
  --adapter-host 127.0.0.1 --adapter-port 4096 --workspace .
```

OpenCode supports model selection, structured output, session reuse, checkpoint
branches, and activity events. It exposes a session UI only if the server
provides a browser URL.

The OpenCode service remains responsible for its tools, filesystem access,
network access, skills, and approvals. Seqlane does not change those settings.
