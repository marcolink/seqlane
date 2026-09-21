# Resolve merge conflicts

Directs an agent to resolve a bounded list of existing merge-conflict files.

Run: `seqlane run workflows/resolve-merge-conflicts/workflow.ts --input '<conflict-resolution input JSON>' --adapter opencode`

Input supplies repository, pull-request revisions, strategy, and conflicted
paths. Output supplies a summary, resolved paths, and per-file decisions. It
requires a prepared conflicted checkout and configured model runtime. A
consumer owns conflict discovery, checkout, and publishing; this graph edits
only supplied files. Consumers use the private
`@seqlane/resolve-merge-conflicts-workflow` package.

The resolver uses `openai/gpt-5.6-luna` with high reasoning.
