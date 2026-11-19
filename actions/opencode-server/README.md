# OpenCode server action

Starts an already-installed OpenCode executable, waits for `/global/health`,
and stops the process group in the action post handler.

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
