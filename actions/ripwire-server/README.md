# Ripwire server Action

`ripwire-server` downloads a pinned Ripwire GitHub Release binary, verifies its
SHA-256 checksum, extracts only the binary, starts its HTTP MCP server, and
stops the process group in the post step.

The Action accepts a required `working-directory`. It defaults to Ripwire
`0.4.0`, loopback `127.0.0.1:7998`, `top-k=200`, stable output, redaction, and
read-only remote behavior. Set `mcp-token` for a non-loopback listener or when
`allow-remote-edits` is true. The token is passed to the child only through
`RIPWIRE_MCP_TOKEN` and is never placed in command arguments.

The Action publishes `mcp-url`, `log-path`, `binary-path`, and normalized
`version` outputs. It supports the released Linux and macOS x64 and arm64
assets. It validates all inputs before downloading or starting a process and
uses the shared identity-checked service lifecycle for cleanup.

Startup uses one timeout deadline for all MCP probes. The Action checks the
listen port before it starts Ripwire and verifies process identity and
liveness after readiness. A readiness response must report the exact MCP
protocol version, `serverInfo.name` `ripwire`, and Ripwire server software
version `1.0`; this is separate from the downloaded release version. Child
processes receive an explicit minimal environment. The Action removes failed
partial installs and removes a successful install directory only after the post
step confirms process termination.

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
  run: echo "Ripwire is ready at $RIPWIRE_MCP_URL"
```

## Inputs

| Input                     | Required | Default          | Description                                                                                      |
| ------------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `working-directory`       | Yes      | -                | Directory that Ripwire indexes and serves.                                                       |
| `version`                 | No       | `0.4.0`          | Exact Ripwire release version. A leading `v` is accepted and removed from the normalized output. |
| `listen`                  | No       | `127.0.0.1:7998` | HTTP listen address in `host:port` format. A non-loopback address requires `mcp-token`.          |
| `top-k`                   | No       | `200`            | Maximum number of ranked symbols.                                                                |
| `stable-order`            | No       | `true`           | Enable stable MCP output order.                                                                  |
| `redact`                  | No       | `true`           | Enable sensitive source-content redaction.                                                       |
| `mcp-token`               | No       | -                | Bearer token for the MCP server. Store this value as a GitHub secret.                            |
| `allow-remote-edits`      | No       | `false`          | Enable remote MCP edit operations. This setting requires `mcp-token`.                            |
| `startup-timeout-seconds` | No       | `30`             | Maximum time to wait for a valid MCP initialize response.                                        |

## Outputs

| Output        | Description                                       |
| ------------- | ------------------------------------------------- |
| `mcp-url`     | Ready Ripwire MCP HTTP endpoint.                  |
| `log-path`    | Absolute path to the Ripwire server log.          |
| `binary-path` | Absolute path to the verified Ripwire executable. |
| `version`     | Normalized Ripwire version without a leading `v`. |
