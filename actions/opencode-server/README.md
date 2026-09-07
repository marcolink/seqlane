# OpenCode server action

Starts an already-installed OpenCode executable, waits for `/global/health`,
and stops the process group in the action post handler.

The public contract is compatible with the legacy `.github/actions/opencode-server`
action. The caller owns OpenCode installation and configuration.
