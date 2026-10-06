# Code-review Action library

This private package contains the trusted code-review workflow, the model-free
publication workflow, Action contracts, and narrow GitHub ports. It has no
GitHub Actions Toolkit dependency. The Node 24 Action entrypoint adapts Toolkit
inputs and GitHub clients to these ports, then invokes both bundled workflows
through `startWorkflowRun`.

Reports have a 60,000-byte publication limit. The publisher compacts metrics
JSON whitespace before shortening review text, removing task details, or
reducing visible findings. Text compaction adds a limitation notice.
If task details exceed the limit, it retains run totals and adds a limitation
notice. It then reduces finding rows in priority order, retaining the complete
bounded finding state. A report with retained findings never says "No findings."
If one finding row and the required state cannot fit, publication fails.

## Incremental scope collector

`collectReviewScopeEvidence` is the first private v5 implementation slice.
The current v4 workflow does not call it. It consumes a trusted admission,
collects complete Git evidence, and returns deterministic batches without model calls
or publication writes. A v4 report cannot supply its checkpoint.

```ts
import { collectReviewScopeEvidence } from "@seqlane/action-code-review";

const evidence = await collectReviewScopeEvidence(
  {
    mode: "incremental",
    pullRequestNumber: 112,
    targetBranch: capturedTargetBranch,
    baseRevision: capturedBase,
    headRevision: capturedHead,
    checkpointRevision: publishedV5Checkpoint,
    reportId: trustedReportId,
  },
  { git: boundedGit, admittedAt: admissionStartedAt },
);
```

The pure selector uses the complete PR path set for a baseline.
For incremental scope, it intersects that set with checkpoint-to-head tree changes.
It then excludes lockfiles and generated `dist` contents.
Baseline review batches contain the current PR patch. Incremental review
batches contain only the checkpoint-to-head diff. Separate `validationBatches`
hold current-PR evidence for local cause admission; discovery input uses only
`batches`. The workflow must also load prior findings when the v5 reader is wired.
Prior findings are reference context. Only findings whose recorded causes
overlap new changes get rechecked. A changed file alone is insufficient.
Untouched findings carry forward as
`not_reviewed`. Empty scope skips all model work, including history verification
and synthesis; production orchestration must enforce these rules when wired.
Raw tree-entry metadata preserves binary, mode, symlink, and submodule changes.
Empty reviewable scope produces no scoped diff.

Each selected revision range uses one bounded multi-path Git command. A
baseline uses one patch command; an incremental review uses two, including
local validation. Commands include all selected literal paths, up to 200.
The parser verifies the raw inventory and every patch header before grouping
whole paths into bounded batches. Missing, extra, or duplicate evidence fails.
Review and validation batches share the batch, hunk, byte, and execution limits.

The trusted host must implement `BoundedReviewGitPort`.
It must stream raw bytes and enforce the supplied wall, CPU, memory, output,
and transfer limits. It must terminate the complete process group on cancellation
or a breach. It must disable automatic lazy fetches during local Git commands.
Every result must include resource measurements and explicit non-truncation flags.
The collector charges all commands and exact-checkpoint fetches to one admission budget.
Base, head, and checkpoint IDs must match the repository's storage hash format:
40 characters for SHA-1 or 64 for SHA-256. Each ID must resolve to exactly that
commit object. Abbreviated IDs, tags, trees, and blobs are rejected.
Malformed data, unavailable checkpoints, stale HEAD, missing measurements,
oversized evidence, and budget breaches reject the run.
It never truncates evidence or resets to a baseline.

The production host adapter, trusted v5 reader, model admission, and publication
wiring remain follow-up work. The test-only Git adapter requires Git and Python 3
for child resource measurements. It does not implement production resource controls
and is excluded from the package build.

Run the test-mapping check before the focused collector tests:

```sh
pnpm run test:mapping
pnpm --dir libs/action-code-review exec vitest run src/review-scope-selection.spec.ts src/review-git-records.spec.ts src/review-git-budget.spec.ts src/review-scope-evidence.spec.ts
```
