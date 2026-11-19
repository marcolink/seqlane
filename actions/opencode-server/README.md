# OpenCode server action

Starts an already-installed OpenCode executable, waits for `/global/health`,
and stops the process group in the action post handler. Each health request has a
two-second timeout within the overall startup deadline. OpenCode 1.x can accept a
request before its routes are ready and leave that request unanswered. The short
timeout lets the Action retry on a new connection.

If startup fails, the Action reports the last 16 KiB of the server log as a
warning. It removes `OPENAI_API_KEY`, `OPENCODE_SERVER_PASSWORD`, and newline-separated
values from `SEQLANE_REDACT_VALUES`. The `log-path` output is available on failure.
The timeout error includes the last health-probe failure and preserves its cause.

The Action keeps startup cleanup ownership until it saves validated process
and sentinel identities, receives the resident process's adoption
acknowledgment, and passes readiness. The post handler validates those saved
identities before cleanup. The production bundle includes the resident
process anchor beside its main and post entrypoints.

The caller owns OpenCode installation and configuration. Pass the executable
path explicitly:

```yaml
- uses: ./actions/opencode-server
  with:
    working-directory: ${{ github.workspace }}
    executable: /path/to/opencode
```

The `executable` input is required. This action does not install OpenCode and
does not provide a default executable name.

The hosted CI smoke test starts the pinned OpenCode executable through this
Action and checks its health response. It makes no model calls.
