# zvec-grep server action

Starts zvec-grep through `pnpm dlx`, waits for its readiness command, and
stops the process group in the action post handler.

Indexing policy remains caller-owned.
