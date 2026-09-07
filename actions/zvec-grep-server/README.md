# zvec-grep server action

Resolves the requested zvec-grep version through `pnpm dlx`, indexes the
configured project with the supported source-file policy, starts the MCP
server, waits for readiness, and stops the process group in the action post
handler.

`working-directory` is the project indexed. The Action caller does not need a
separate install or index step. Package-manager commands run from the shipped
Action directory; the reviewed project is passed only as the explicit index
argument.

`listen` must include a hostname and a non-default explicit port. The Action
normalizes it before package resolution and uses the same canonical address for
the server and `mcp-url` output. Bracketed IPv6 addresses are supported.

Indexing uses fixed `direct` mode and defaults to the
`local/potion-code-16m-v2` embedding and a `1M` maximum file size. Override
the embedding and maximum size with `embedding` and `max-filesize`. The `glob`
input accepts newline-delimited additional include patterns. These patterns
are appended after the built-in allowlist and before the immutable exclusions,
so they can add source types but cannot include secrets, private material,
generated output, or other excluded paths.

`model-cache` is a boolean and defaults to `true`. When enabled, the Action
sets `ZVEC_GREP_MODEL_CACHE` to a runner-temp cache directory. When disabled,
the variable is omitted; `ZVEC_GREP_HOME` is always set. Invalid boolean input
fails at the Action input boundary.
