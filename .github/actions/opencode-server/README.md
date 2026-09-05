# OpenCode server action

Starts an already-installed OpenCode executable, waits for
`/global/health`, and stops the process group in the action post handler.

The caller owns OpenCode installation and configuration. Pass credentials and
`OPENCODE_CONFIG_CONTENT` through the step environment. The action does not
print the inherited environment or server log contents.
