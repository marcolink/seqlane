# Local Git status example

Runs `git status --porcelain=v1` and asks an agent to summarize it.

Run: `seqlane run workflows/local-git-status-example/workflow.ts --input '{}' --adapter opencode`

Input is `{}`; output is `{ summary: string }`. Run it in a Git checkout with
Git and an installed and authenticated OpenCode adapter available. This is a visibly marked
authoring example; a consumer must provide any environment-specific setup.
