# GitHub Workflow Instructions

These instructions apply to workflows under `.github/workflows/`.

- Grant the minimum required `GITHUB_TOKEN` permissions.
- Check out the repository before invoking a local action with `uses: ./...`.
- Use `fetch-depth: 0` when an action needs history, tags, merge bases, or rebasing.
- Be explicit about the checked-out ref when a workflow may commit or push.
- Pull-request workflows commonly start on a detached synthetic merge commit; do not assume it is a writable branch.
- Do not combine privileged `pull_request_target` execution with checkout and execution of untrusted pull-request code.
- Keep remote push behavior out of normal pull-request tests.
- Test local action code with `uses: ./actions/<name>`.
- Verify that committed action bundles are current.
- Run `actionlint` for workflow syntax, expressions, Action inputs and outputs, and reusable workflow contracts.
- Use `act` only for local smoke tests without real push credentials. Treat GitHub-hosted runs as authoritative for permissions, tokens, checkout trust, and remote writes.
- Prefer fixture repositories or temporary branches for tests that require remote Git mutations.
