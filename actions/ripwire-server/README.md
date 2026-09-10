# Ripwire server Action

`ripwire-server` downloads a pinned Ripwire GitHub Release binary, verifies its
SHA-256 checksum, extracts only the binary, starts its HTTP MCP server, and
stops the process group in the post step.

The Action accepts a required `working-directory`. It supports the trusted
Ripwire `0.4.0` assets for Linux and macOS on x64 and arm64. It defaults to
loopback `127.0.0.1:7998`, `top-k=200`, stable output, redaction, and read-only
remote behavior. Set `mcp-token` for a non-loopback listener or when
`allow-remote-edits` is true. The input is a secret seed. The Action derives a
new bearer token for each run. It passes only that token to the child through
`RIPWIRE_MCP_TOKEN`. It never places either value in command arguments.

The Action publishes `mcp-url`, `log-path`, `binary-path`, normalized `version`,
and a secret per-run `mcp-token` output. It validates all inputs before a
download or process start. It uses the shared identity-checked service
lifecycle for cleanup.

The release archive must match both the downloaded upstream checksum and the
repository-controlled SHA-256 digest before extraction. The release
`--version` check runs with the same explicit minimal environment as the
server. Ambient credentials, Action inputs, Node loader variables, and other
ambient secret variables are not inherited.

If spawn fails after it validates primary or sentinel process identity, startup
saves that ownership in `service-state` when cleanup is not verified. Post can
retry identity-checked termination from that state. If spawn returns no
validated ownership, post cannot safely retry and the install remains for
runner-level cleanup.

If partial-install removal fails, the Action wraps the acquisition failure in a
typed `RipwireInstallError`. The wrapper preserves the original error as its
cause and message. The Action warns about the cleanup error and saves the
install path with a validated cleanup-only marker. Post removes that path only
when the marker is present.

Startup uses one timeout deadline for all MCP probes. The Action checks the
listen port before it starts Ripwire. It verifies process identity and liveness
after readiness. A readiness response must report the exact MCP protocol
version, `serverInfo.name` `ripwire`, and Ripwire server software version
`1.0`. This server version is separate from the downloaded release version.
Each probe opens one unauthenticated TCP connection before it sends a request.
On Linux, the Action uses `/usr/bin/ss`; on macOS, it uses `/usr/sbin/lsof`. It
verifies that the listening process belongs to the spawned process group while
the connection is held. It then sends the authenticated request on that same
connection. A racer cannot receive the bearer token or satisfy readiness
without this proof.
Child processes receive an explicit minimal environment. The Action removes
failed partial installs when possible. It removes a successful install
directory only after the post step confirms process termination.

Each run creates a new bearer token. If `mcp-token` is provided, the Action
uses it only as a secret derivation seed. The child and readiness probe receive
only the derived per-run token. The token is available in the secret `mcp-token`
output for authenticated callers.

## Usage

```yaml
- name: Start Ripwire
  id: ripwire
  uses: ./actions/ripwire-server
  with:
    working-directory: ${{ github.workspace }}

- name: Use the MCP endpoint
  env:
    RIPWIRE_MCP_URL: ${{ steps.ripwire.outputs.mcp-url }}
    RIPWIRE_MCP_TOKEN: ${{ steps.ripwire.outputs.mcp-token }}
  run: echo "Ripwire is ready at $RIPWIRE_MCP_URL"
```

## Inputs

| Input                     | Required | Default          | Description                                                                             |
| ------------------------- | -------- | ---------------- | --------------------------------------------------------------------------------------- |
| `working-directory`       | Yes      | -                | Directory that Ripwire indexes and serves.                                              |
| `version`                 | No       | `0.4.0`          | Repository-trusted Ripwire release version. Currently, only `0.4.0` is trusted.         |
| `listen`                  | No       | `127.0.0.1:7998` | HTTP listen address in `host:port` format. A non-loopback address requires `mcp-token`. |
| `top-k`                   | No       | `200`            | Maximum number of ranked symbols.                                                       |
| `stable-order`            | No       | `true`           | Enable stable MCP output order.                                                         |
| `redact`                  | No       | `true`           | Enable sensitive source-content redaction.                                              |
| `mcp-token`               | No       | -                | Secret seed for the per-run MCP bearer token.                                           |
| `allow-remote-edits`      | No       | `false`          | Enable remote MCP edit operations. This setting requires `mcp-token`.                   |
| `startup-timeout-seconds` | No       | `30`             | Maximum time to wait for a valid MCP initialize response (1 through 600 seconds).       |

## Outputs

| Output        | Description                                          |
| ------------- | ---------------------------------------------------- |
| `mcp-url`     | Ready Ripwire MCP HTTP endpoint.                     |
| `log-path`    | Absolute path to the Ripwire server log.             |
| `binary-path` | Absolute path to the verified Ripwire executable.    |
| `version`     | Normalized Ripwire version without a leading `v`.    |
| `mcp-token`   | Per-run bearer token for authenticated MCP requests. |
