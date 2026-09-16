# Resolve merge conflicts

Directs an agent to resolve a bounded list of existing merge-conflict files.

Run: `seqlane run workflows/resolve-merge-conflicts/workflow.ts --input '<conflict-resolution input JSON>' --runtime opencode`

Input supplies repository, pull-request revisions, strategy, and conflicted
paths; output supplies a summary, resolved paths, and per-file decisions. It
requires a prepared conflicted checkout and configured model runtime. A
consumer owns conflict discovery, checkout, and publishing; this graph edits
only supplied files.
