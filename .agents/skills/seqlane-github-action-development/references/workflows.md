# GitHub Action Workflows

Read `.github/workflows/AGENTS.md` before you change a workflow.

Use a JavaScript Action for reusable TypeScript behavior. Use a composite
action for small step-level glue. Use a reusable workflow for complete jobs,
permissions, runner selection, and CI orchestration.

Check out the repository before a workflow uses a local action. Reference the
action with `uses: ./actions/<name>`.

Set `fetch-depth: 0` when the action needs history, tags, merge bases, or a
rebase. Set the checkout ref explicitly when the workflow can commit or push.

Do not run untrusted pull-request code in a privileged `pull_request_target`
workflow. Keep remote push behavior out of normal pull-request tests.

Use a GitHub-hosted runner to test changed action behavior or metadata. Use a
fixture repository or a temporary branch for remote Git mutations.
