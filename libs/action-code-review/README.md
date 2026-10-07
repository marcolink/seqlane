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

## Trusted v5 admission

The private `admitReviewScope` entry point connects trusted report classification
to the incremental scope collector. The production v4 workflow does not call it.

```ts
import { admitReviewScope } from "@seqlane/action-code-review";

// Before: the v4 reader returns undefined for missing or invalid state.
const previousState = parseReviewState(previousReport);

// After: the private v5 path rejects invalid current state before Git work.
const admission = await admitReviewScope(
  { pullRequest: frozenPullRequest },
  { authority: githubReadPort, git: boundedGit, signal },
);
```

The frozen PR contains `repositoryId`, `pullRequestNumber`, `targetBranch`,
`baseRevision`, and `headRevision`. Capture these before admission.
Admission performs authority lookup itself through the required read-only
`authority` port. Caller-supplied `history` is rejected; it cannot bypass lookup.
The GitHub port returns raw issue-comment pages with `items` and explicit
`hasNextPage`. Lookup requires two matching inventories, each limited to two
pages and 200 comments: at most four requests, with no retries. Changed
identities, content, authors, timestamps, or ordering block admission with
`REVIEW_AUTHORITY_UNSTABLE`. This consistency check is not an atomic snapshot;
later publication guards must still verify authority. Malformed
records, incomplete pagination, truncated bodies, and duplicate trusted
reports block admission. The default authors are `github-actions` and
`github-actions[bot]`; the caller can supply its trusted bot authors.

An absent report selects a new baseline. Every v1–v4 report selects a full
current-PR baseline after validating its trusted marker identity. Its payload
is never decoded. No old finding, checkpoint, metric, cost, or artifact enters
admission. Only its report ID and exact marker digest remain for later guards.
Future versions and malformed v5 reports block. A valid v5 report selects its
published `reviewedRevision` as the checkpoint and preserves all retained
findings as reference context. Artifact expiry alone does not reset that checkpoint.
Metadata JSON must have unique decoded property names before version routing.
Duplicate keys, including escaped aliases, select `invalid-current`; they cannot
downgrade a report to legacy or reset its checkpoint.

Shared strict v5 schemas are exported by
`@seqlane/code-review-workflow/contracts`. `encodeReviewStateV5` and
`decodeReviewStateV5` use canonical JSON, deterministic gzip, canonical base64,
and one matching metadata marker and hidden state block. Decoding bounds both
compressed and streamed expanded bytes, validates UTF-8, and checks identity
and evidence digests. It reads no artifact and performs no publication write.
Admission returns classification, scope identity, retained findings, and evidence.
It allocates no generation or finding ID and makes zero model calls.

Retained findings must match the canonical lifecycle matrix:

| Status      | Comparison                   | Verification outcome           |
| ----------- | ---------------------------- | ------------------------------ |
| `new`       | `new`, `not_reviewed`        | `null`, `present`, `uncertain` |
| `open`      | `persisting`, `not_reviewed` | `null`, `present`, `uncertain` |
| `addressed` | `persisting`, `not_reviewed` | `null`, `uncertain`            |
| `resolved`  | `resolved`, `not_reviewed`   | `absent`                       |
| `reopened`  | `persisting`, `not_reviewed` | `present`                      |

Reviewed resolution and reopening require verification at the published head.
`not_reviewed` preserves valid historical verification and lifecycle without
claiming a fresh check. Missing or contradictory proof blocks admission.

## Native Git evidence

The existing `admitReviewScope` entry point owns the shared 120-second deadline.
It passes the same signal to raw authority reads and the Git collector. Authority
ports must pass that signal to HTTP requests and disable retries.

```ts
// Before: separate admission wrapper and host lifecycle.
await admitReviewScopeWithGitHost(input, options, createAuthority);

// After: existing admission with the private byte-safe adapter.
await admitReviewScope(input, {
  authority: githubReadPort,
  git: createReviewGitAdapter({ reviewTarget, trustedRemote }),
  signal,
});
```

`context.exec` returns text and inherits the process environment. The private
Git adapter preserves raw bytes and uses controlled Git configuration. It
implements the existing `BoundedReviewGitPort`, without a host lifecycle or a
second local-command grammar. Only trusted collector code constructs local argv.
Owning schemas validate untrusted revisions, paths, remote configuration, and
raw results. Public runtime and executor APIs stay unchanged.

Git counts stdout and stderr together before retaining output. Timeout,
cancellation, and overflow stop the ordinary process group even after Git exits.
Cleanup has a finite grace period; unconfirmed termination is a typed failure.
Independently detached processes are outside this contract. The existing budget
accounts for complete output and measured wall time across all operations.

Local collection disables replacement objects, lazy fetch, hooks, executable
helpers, prompts, protocols, and inherited credentials. Native exact-checkpoint
fetch uses operation-local temporary configuration and trusted HTTPS settings.
Target URLs, rewrite rules, and credentials cannot affect fetch. Credentials
use environment-backed configuration; prompts and redirects are disabled.
The trusted runner may supply `GIT_SSL_CAINFO`. Fetch preserves HEAD, index, and
worktree and releases temporary files in `finally`. Missing checkpoints fail
without retries or baseline fallback.

Real-Git fixtures cover both object formats. The production v4 caller remains
unchanged; production v5 wiring, models, manifests, and publication are later work.

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
`batches`. The private admission path loads prior findings; production wiring remains pending.
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
It must preserve raw bytes and enforce the supplied timeout and output limits.
It stops Git and its ordinary process group on cancellation or a breach.
It must disable automatic lazy fetches during local Git commands.
Every result includes measured wall time and explicit non-truncation flags.
The collector charges all commands and exact-checkpoint fetches to one admission budget.
Base, head, and checkpoint IDs must match the repository's storage hash format:
40 characters for SHA-1 or 64 for SHA-256. Each ID must resolve to exactly that
commit object. Abbreviated IDs, tags, trees, and blobs are rejected.
Malformed data, unavailable checkpoints, stale HEAD, invalid wall measurements,
oversized evidence, and budget breaches reject the run.
It never truncates evidence or resets to a baseline.

The private native Git adapter is available. Workflow wiring, model admission,
and publication remain follow-up work. Real-Git tests use the same native adapter
and require Git, with no Python dependency.

Run the test-mapping check before the focused collector tests:

```sh
pnpm run test:mapping
pnpm --dir libs/action-code-review exec vitest run src/review-scope-selection.spec.ts src/review-git-records.spec.ts src/review-git-budget.spec.ts src/review-scope-evidence.spec.ts
```

Admission, codec, authority, classifier, and shared schema checks:

```sh
pnpm run test:mapping
pnpm --dir libs/action-code-review exec vitest run src/review-report-authority.spec.ts src/review-report-classification.spec.ts src/review-state-codec.spec.ts src/review-v5-state.spec.ts src/review-scope-admission.spec.ts
```
