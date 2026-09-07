# zvec-grep server action

Starts zvec-grep through `pnpm dlx`, waits for its readiness command, and
stops the process group in the action post handler.

The public contract is compatible with the legacy
`.github/actions/zvec-grep-server` action. Indexing policy remains caller-owned.
