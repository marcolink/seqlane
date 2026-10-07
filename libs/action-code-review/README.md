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
  { authority: githubReadPort, git: boundedGit, admittedAt, signal },
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

## Production Git host for private v5 admission

`createReviewGitHost` implements the collector's bounded Git port.
`admitReviewScopeWithGitHost` owns its lifecycle and the 120-second admission deadline.
The deadline starts before host setup and authority reads.
The authority factory must bind its signal to raw GitHub requests and disable retries.
A cancelled read also settles if a defective port never resolves.

```ts
// Before: tests supplied the bounded Git port and owned its deadline.
const admission = await admitReviewScope(
  { pullRequest },
  { authority, git: fixture.git, admittedAt, signal },
);

// After: the private host owns setup, the deadline, and cleanup.
const admission = await admitReviewScopeWithGitHost(
  { pullRequest },
  { reviewTarget, cgroupRoot, trustedRemote, signal },
  (admissionSignal) => createRawGithubReadPort(admissionSignal),
);
```

This host supports Linux x64 and arm64, with `/usr/bin/git` and `/usr/bin/python3`.
Trusted runner setup must provide an owned, writable cgroup v2 directory.
Its `cgroup.subtree_control` must enable `cpu`, `memory`, and `pids`.
An unprivileged launcher must already run in a separate leaf below that root.
Kernel migration checks require write access to the common ancestor's `cgroup.procs`.
Trusted setup places the launcher, then restores the normal runner identity before executing Action code.
The launcher stays outside the bounded Git workload groups.
Trusted cleanup removes the owned root with permission to write its parent directory.
The host probes controls before target Git starts.
Missing controls, unsupported hosts, or failed accounting block admission.
The embedded Python supervisor travels with TypeScript output and Action bundles.
It does not depend on the source checkout or current working directory.

Each Git command enters its own cgroup before execution.
Memory accounting includes the group's charged memory, including file cache.
`memory.max` enforces the 256 MiB default; swap is disabled.
CPU accounting covers Git and all descendants, including detached children.
The group has a one-core CPU quota with a 1 ms period.
A 1 ms monitor stops work 5 ms before the remaining cumulative CPU allowance.
CPU limit failures report that conservative guard and the actual observed value.
Scheduling can delay the monitor; final accounting rejects any overshoot.
The host never reports a successful result with excessive measured usage.
Wall time includes command setup and cleanup.
Raw stdout and stderr share one allowance, enforced before retaining bytes.
Overflow fails without returning truncated evidence.
Cancellation kills and reaps every descendant before the operation settles.
An independent parent cleanup path handles supervisor failure.
Call `close()` in `finally` when using the factory directly.
The host permits one active operation and rejects work after closure.

Local Git uses literal pathspecs and disables replacement objects and lazy fetch.
It receives an isolated environment without inherited credentials or Git configuration.
Fixed overrides disable hooks, filesystem monitors, credential helpers, and external reference helpers.
Only collector commands are accepted; diff disables external diff and text conversion.
An inherited seccomp filter denies sockets and `io_uring` networking.
Git transport protocols are disabled, including file transport.
These controls govern trusted Git, not execution of arbitrary target programs.

Exact fetch uses a caller-supplied trusted HTTPS repository URL.
Build that URL from trusted repository identity, never target Git configuration.
An optional `authorization` header stays in the HTTPS adapter.
It never enters Git argv, Git's environment, returned stderr, or diagnostics.
Target remote URLs and rewrite rules cannot choose the fetch route.
The adapter supports smart HTTP v0/v1 with shallow, sideband pack transfer.
It requests one full SHA-1 or SHA-256 commit, without thin packs or alternate URIs.
Unsupported servers fail; there is no branch fallback or retry.

The 16 MiB fetch allowance counts incoming HTTP response-body bytes across both requests.
It includes the reference advertisement and upload-pack response.
It excludes HTTP headers, TLS/TCP overhead, and the small outgoing request body.
The adapter requests identity encoding and rejects encoded responses and redirects.
A dedicated HTTPS agent prevents inherited proxy routing.
Downloaded pack bytes enter supervised `git index-pack --stdin`.
Fetch changes only the local object database; HEAD, index, and worktree stay unchanged.
The collector then repeats exact commit-ID and object-type validation.

The admission-only Linux gate uses temporary repositories, reports, and an HTTPS Git server.
It supplies no model credentials and has no comment or artifact write permission.
Run it after trusted runner setup:

```sh
SEQLANE_REVIEW_CGROUP_ROOT=/sys/fs/cgroup/owned-review-root \
  pnpm exec nx run action-code-review:verify-git-host
```

The existing CI workflow runs `actions/code-review/tests/git-host-cgroup-smoke.sh`
when review code, its Action, or CI changes.
The script provisions and removes its owned root.
It starts the fixture in the root's `supervisor` leaf as the normal runner user.
The gate verifies both hash formats, literal paths, exact fetch, resource breaches,
network denial, cancellation, and descendant cleanup from a packaged host.
Bundles remain ignored. The production v4 workflow still has no v5 admission call.
Model execution, finding admission, manifests, and guarded publication remain pending.

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

The production host adapter, workflow wiring, model admission, and publication
remain follow-up work. The test-only Git adapter requires Git and Python 3
for child resource measurements. It does not implement production resource controls
and is excluded from the package build.

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
