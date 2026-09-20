# Git diff summary example

Runs two independent lanes for the same local Git ref:

- `direct` uses one agent task to inspect and summarize the diff.
- `evidence` runs a shell task first, then gives its Git evidence to one agent
  task.

Run from a checkout with at least two commits:

```sh
pnpm exec node apps/cli/bin/run.js run \
  workflows/git-diff-summary-example/workflow.ts \
  --input '{"branch":"HEAD"}' \
  --adapter opencode \
  --workspace "$PWD" \
  --output ci
```

Input is `{ branch: string }`, where `branch` is an existing local Git ref.
The workflow reads `branch~1..branch` and does not change the checkout.

Output contains one structured report for each lane. The reports use the same
schema and instructions. Compare the token counts for
`git-diff-summary-example-direct-agent` and
`git-diff-summary-example-summarize-evidence` in the CI output. The shell task
does not use model tokens. The evidence lane disables external Git diff
processing, uses a five-minute timeout, and bounds evidence at 512,000 bytes.
Large evidence is marked as truncated; an invalid Git range fails the lane
before the summarizer runs. Token savings vary with the size of the diff and
the adapter.
