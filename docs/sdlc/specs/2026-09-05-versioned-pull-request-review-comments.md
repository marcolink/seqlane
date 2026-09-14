---
id: spec.versioned-pull-request-review-comments
title: Versioned Pull Request Review Comments
status: active
owners:
  - core
created: 2026-09-05
updated: 2026-09-14
upstream: []
supersedes: []
---

# Versioned Pull Request Review Comments

## Summary

The pull-request review example publishes one trusted comment for each pull
request. The comment separates the human review from the persisted review
state.

## Goals

- Give reviewers a short and stable human review.
- Preserve bounded lifecycle state between review runs.
- Prevent an old run from replacing a review for a newer head revision.
- Give each finding one stable publisher-owned identifier.
- Preserve human dispositions without treating a claim as verified evidence.
- Show when a new review is refreshing an existing authoritative comment.
- Preserve deterministic per-run task cost and usage metrics for reviewers.

## Non-goals

- Execute pull-request code, tests, builds, scripts, or checks.
- Store patches, credentials, or secret values in the GitHub comment.
- Replace internal ratings, evidence, or observability data.
- Define a public Seqlane package contract.

## Terminology

- **Authoritative comment:** The trusted bot comment that owns the review state.
- **Human projection:** The concise Markdown review that people read.
- **Review state:** The validated machine data that the next review consumes.
- **Run metrics ledger:** The one human-readable, strict JSON object in the
  authoritative comment that retains completed review-run metrics.
- **Comparable predecessor:** A prior reviewed revision that Git identifies as
  an ancestor of the current reviewed revision.
- **Disposition:** An authorized human decision, such as `wont-fix` or
  `downgrade`.

Review-scope selection and checkpoint advancement are defined in
[spec.incremental-pull-request-review-scope](./2026-09-13-incremental-pull-request-review-scope.md).
The version 3 state below is historical transport and lifecycle input. The
current strict state revision is v5 and adds that spec's scope checkpoint
without changing trusted-comment or run-metrics ownership here.
The incremental-scope specification owns `E`, `X`, `R`, and checkpoint
semantics. [spec.review-run-manifest-and-provenance](./2026-09-14-review-run-manifest-and-provenance.md)
owns manifest schema, persistence, coverage, and provenance. This specification
owns trusted state and final report publication. No external coordinator or
publication journal is required for the v5 review path.

## Requirements

### requirement-trusted-authority

The publisher must read and update comments from the configured bot identity
only. The marker must contain the schema version, pull-request number, and full
reviewed revision.

### requirement-publication-order

The publisher must read the live pull-request state before each write. The
pull request must remain open and eligible. Its head revision must equal the
report revision.

### requirement-publication-state-machine

The Action-library publisher is the sole owner of publication state. The
scope selector and review lanes produce data; they do not write GitHub state.
For v5, publication has one GitHub write: create or update the authoritative
summary after execution and manifest sealing. The final body contains all
admitted and retained findings, limitations, run metrics, status, and the new
checkpoint. There are no pre-publication progress writes or inline finding
writes in this iteration. The workflow job and step summary show progress
without changing the authoritative comment. The existing v3 owning-run notice
remains legacy behavior until the v5 path is delivered.

The publisher records publication as not-started before the final write and
published only after an exact response or readback confirms it. A changed live
head, target, report, or checkpoint is stale; a known failed write is failed.
An ambiguous API result is uncertain: the publisher re-reads the trusted
comment and accepts only an exact operation identity and payload match. It
does not issue a second write while the first may still complete. An
unconfirmed run cannot claim success. A later run reads the live trusted report
before selecting scope.

Every authoritative-comment writer stores an operation identity with writer
kind, pull request, monotonic state revision, source identity, and a SHA-256
digest of the canonical final body with that operation identity omitted.
For a full review, source identity is ScopeIdentity, run ID, and attempt. For a
mechanical disposition, it is the digest of the validated command ledger and
writer identity defined by the disposition contract. The mechanical writer
preserves the review's manifest and checkpoint while computing its own new
body digest.
An exact readback match for the current writer is idempotent evidence of its
write; a mismatch cannot be treated as success. The report itself is the
durable publication record. No separate intent or receipt store is required.

### requirement-serialized-publication

All authoritative-comment writers, including the future mechanical-disposition
path, use the same per-pull-request GitHub Actions publication queue. This is
the queue in
[spec.mechanical-pull-request-review-dispositions](./2026-09-06-mechanical-pull-request-review-dispositions.md#requirement-serialized-publication),
not a second dispatcher. Review computation may retain its existing
cancel-on-new-review group; the final publisher enters a separate shared group
after computation. The publication group uses queue: max without
cancel-in-progress. GitHub admits at most 100 pending jobs to that group and
orders them by when they start waiting, not webhook dispatch time. Queue
overflow is a visible cancelled run; it cannot claim publication. The trusted
publisher and disposition paths must use the same group key for one PR.

After queue admission, the publisher re-reads the live PR and trusted report,
then compares them with the captured ScopeIdentity. A new baseline requires
no authoritative report. Legacy replacement requires the captured report ID
and marker digest. Incremental and no-change modes require the captured
report ID, state digest, and checkpoint. Any mismatch is stale and makes no
write. For an existing report, the final update must use the same trusted
comment ID; it never deletes historical comments. For an absent report, the
queued publisher creates at most one authoritative comment. The mechanical
publisher reconciles the latest authorized command ledger before it writes.
A full review publisher also reconciles decisions that arrived during
computation.

GitHub issue-comment POST and PATCH have no general conditional-write
guarantee. The queue serializes configured bot writers, while the live read
rejects stale work. It cannot protect a writer that bypasses the queue or
guarantee that an ambiguous HTTP request has stopped on job termination. Bot
write credentials must be unavailable to bypass paths and review-target code.
No DynamoDB, external lease, capacity table, or IAM role is part of this
contract. Publication is complete only when the one bounded summary contains
all admitted findings and the final write is confirmed. The checkpoint,
findings, limitations, and publication status change in that one body.

### requirement-run-status-gates

One strict schema defines the joined run status. Unknown enum values, missing
dimensions, or inconsistent combinations are invalid; no consumer may infer
them from a summary, verdict, or a generic success flag.

```text
RunStatus = {
  coverage: "pending" | "complete" | "incomplete"
  finding: "pending" | "valid" | "invalid"
  publication: "not-started" | "in-progress" | "published"
             | "uncertain" | "failed" | "cancelled" | "stale"
  admission: "blocked" | "admissible"
}
```

The manifest finalizer owns `coverage` and `finding`. Before sealing, coverage
changes once from `pending` to `complete` or `incomplete`; finding changes once
from `pending` to `valid` or `invalid`. Finding validity requires schema,
evidence, identity, history, disposition, and cumulative-verdict validation.
Incomplete validation becomes `invalid`, never an implicit success. These
dimensions cannot change after sealing.

The publisher owns publication. Before its one final GitHub write it is
not-started. A confirmed exact write or readback makes it published. A known
failed write is failed; a live-identity mismatch is stale; an ambiguous
response without exact readback is uncertain. Cancellation before publication
is cancelled. A terminal attempt cannot restart; a later retry is a new run
attempt that reads the current trusted report. A v5 report contains only
published, not an in-progress or uncertain checkpoint.

The publisher derives admission mechanically. Admissible means consumers may
accept the completed review result, not that the pull request has merge
approval. A final write is permitted only for a sealed execution outcome of
complete, complete coverage, valid findings, all findings represented in the
bounded summary, and passing live publication guards. All other combinations
are blocked.

| Execution and publication state | Permitted action | Checkpoint | Admission |
| --- | --- | --- | --- |
| Execution pending or incomplete, findings invalid, or summary over budget | Report failure in the Action; no v5 comment write | Preserve | blocked |
| Sealed complete and valid; publication not-started; live guards pass | One final summary create or update | Advance only when confirmed | blocked until confirmed |
| Exact final write or readback confirmed | Accept published report | New checkpoint in that report | admissible |
| Publication uncertain, failed, cancelled, or stale | No further write by that attempt | Read live report on next run | blocked |

The final body carries published and admissible as the postcondition of its
successful guarded write. Constructing that body is not proof of publication.
The single final comment mutation is the only authority transition. If the
response is uncertain, the next run classifies the actual trusted comment;
it never infers success from a local intent.

### requirement-state-contract

The authoritative comment must contain exactly one metadata marker and one
bounded state block. A strict Zod schema must validate the decoded state before
use. The state identity must match the metadata identity.

The state must contain these fields:

- schema version;
- pull-request number;
- base and reviewed revisions;
- comparable predecessor revision, when available;
- the next finding index;
- retained findings, typed finding identity, canonical `identityKey` and
  `occurrenceKey`, and lifecycle metadata;
- review limitations;
- comparison outcomes for retained findings;
- the strict joined `RunStatus`;
- the required final sealed `ManifestReference`, including artifact identity
  and SHA-256 digest;
- the latest publication operation identity and payload digest.

The current state contract is version 5. Its strict envelope and marker must
agree on `schemaVersion: 5` and must contain the scope checkpoint, generation-
qualified finding IDs, typed comparison outcomes, publication status, and
manifest reference defined by the linked specifications. The v3 state and
numeric finding IDs described below are legacy input only; they are never
written as the current state after scope-capable delivery. V4 is a
disposition-only transitional state and is also never an incremental
checkpoint.

A v5 reference must match the report's repository, pull request, reviewed
revision, run, and scope identity. Missing or malformed manifest references or
digests classify the report as `invalid-current` and fail closed. They never
select legacy replacement or an automatic baseline. Artifact expiry does not
erase a structurally valid reference or reset the published Git checkpoint.
A later run records that old audit evidence is unavailable and performs fresh
work.

### requirement-run-status-and-metrics

The v3 implementation prepends an owning-run in-progress notice and removes
it after publication or terminal failure. This is legacy behavior. The v5
path performs no progress write or cleanup; Action job status is its progress
signal. A v3 notice is never a v5 checkpoint.

The publisher must mechanically derive one metrics object for each completed
review run from the serialized execution events. Each task entry must include
the task identity, result state, duration, and any available model, provider,
token, and cost values. The object must include run duration, total cost, and
token totals. The publisher must not use an agent to calculate or interpret
these values.

The authoritative comment must contain exactly one marked, human-readable run
metrics ledger. The ledger is a plain JSON object with a schema version and a
`runs` array. Every run entry must contain the GitHub workflow run ID, attempt,
completion time, reviewed revision, and the mechanically derived metrics
object. The run ID and attempt form the entry identity. A new run appends one
entry unless that identity already exists. Missing provider metrics must remain
absent rather than being represented as fabricated zero usage.

The ledger is the only source for rendered run metrics. The human projection
may calculate total pull-request cost, last-run cost, and run count from
`runs`, but it must not persist those derived values in the ledger. The
publisher must not create or read separate per-run audit comments.

The reader must strictly validate the marked ledger independently of review
state. A missing, malformed, unsupported, or legacy ledger is an empty ledger.
It must not cause the publisher to discard the otherwise valid review state,
findings, or lifecycle data. No metrics-ledger migration or recovery path is
required.

Before publication, the publisher must re-read the current trusted report and
skip a stale write when its run metadata no longer matches the report read at
review start. Ledger updates must be idempotent by run ID and attempt.

### requirement-stable-identity

The local finalizer owns final finding identifiers. A new identifier uses the
format `SEQ-PR{number}-{index}` with a three-digit minimum index.

The finalizer must not reuse an index. A retained or reopened finding keeps its
identifier. Review agents can reference prior identifiers but cannot allocate
new final identifiers.

Each retained finding stores its typed identity, canonical location-independent
`identityKey`, and semantic `occurrenceKey` under the
[scope identity algorithm](./2026-09-13-incremental-pull-request-review-scope.md#requirement-new-finding-admission).
Equal pairs identify duplicates only after local evidence confirms the same
occurrence. Distinct or ambiguous occurrences retain independent evidence,
lifecycle status, dispositions, and comparison outcomes even when prose matches.

The finalizer must collapse duplicate temporary and legacy identifiers before
it assigns stable identifiers. Legacy deduplication must mark the state as
truncated and add a limitation.

The incremental-review scope contract uses generation-qualified IDs for new
baseline reports. This prevents a disposition aimed at an older report from
applying to a new finding after that report is replaced. The numeric format
above remains a version 3 legacy input contract only.

### requirement-lifecycle

Each retained finding has one lifecycle status:

- `new`: the current review detected the finding for the first time;
- `open`: the current review detected an active prior finding;
- `addressed`: an authorized fix claim exists, but verification is incomplete;
- `resolved`: current-head verification found that the problem is absent;
- `reopened`: the current review detected a previously resolved finding;
- `dismissed`: an authorized decision accepts the finding or rejects its
  applicability.

A downgrade changes effective severity. It does not dismiss the finding.
Command names and finding identifiers are case-insensitive.

Each retained finding also has a separate typed `comparisonOutcome` with one of
`new`, `persisting`, `resolved`, or `not_reviewed`. This field is stored in the
validated state and rendered in the human projection; it does not replace
lifecycle status, severity, or disposition. `not_reviewed` is assigned when the
later run omits the finding's path from its reviewable scope and cannot change
the lifecycle or imply resolution. `resolved` and `reopened` require
current-head verification under `requirement-fixed-verification`. Authorized
dispositions remain authoritative when comparison output is merged.

### requirement-fixed-verification

A `/seqlane fixed` command is a claim and sets an unresolved finding to
`addressed`. A separate review task must inspect each claimed fix against the
current head.

The task must return a typed result for each inspected finding. Each result
must contain the finding identifier, head revision, outcome, and bounded
evidence.

Only a `resolved` result for the current head can set the finding to
`resolved` or keep it resolved. A missing, stale, or uncertain result keeps the
finding active. Removing or retargeting the authorizing disposition reopens a
previously resolved finding, even when current-head verification reports that
the original implementation is absent.

An edited comment triggers review only when its current or previous body has a
recognized command. This permits command removal without running reviews for
unrelated comment edits.

Comment collection must preserve recognized command lines even when it bounds
the surrounding comment body. It must retain the latest commands before
optional context when it applies the final comment bound. It must mark history
as truncated if older command lines do not fit. The collector must enforce one
aggregate command-count and text budget across the retained history. Before it
applies that budget, it must retain only the latest command for each finding
and authorization class. The collector must mark each comment that loses a
command to the aggregate budget. Lifecycle reconciliation must preserve a
prior disposition when its authorizing comment has this marker. It must still
reopen the finding when the command was removed or retargeted without
projection loss.

### requirement-human-projection

The human projection must show the verdict, active counts, reviewed revision,
and one findings table. It must not render slash-command syntax. It must show
plain Markdown sections for active Critical and Required findings. Each section
must show the finding ID, severity, area, location, explanation, and
resolution.

Severity and lifecycle labels must use the emoji vocabulary from the source
review template.

The projection can omit internal ratings and run evidence. It must show a
deterministic limitation notice when retained evidence or history is
incomplete.

The projection shows at most 20 retained findings and 10 verification entries.
The state block retains the complete bounded state when the projection omits
items.

The projection must neutralize model-controlled text before Markdown renders
it. Active Critical and Required findings must remain visible before inactive
history when the projection reaches its limit.

### requirement-bounds

The state and human projection must have explicit size and item limits. The
retention policy must keep active blockers before non-blocking or inactive
findings. The v5 state admits at most 40 retained findings, matching the
review-output bound. If older history cannot fit, it adds a visible truncation
limitation; it never silently drops an active blocker or publishes a clean
verdict from incomplete retained state. If active blockers alone exceed the
bound, publication fails and preserves the previous checkpoint. The human
projection may show 20,
while the state retains the complete bounded set.

The publisher must reject an oversized final comment. Snapshot decompression
must stop at the configured output limit.

The workflow must pass bounded review input through a file. It must not place
the complete comment history in one command-line argument.

### requirement-review-boundary

The final note must state that the review agents did not execute pull-request
code, tests, builds, scripts, or checks. The note must not claim that the
workflow performed no Git operations.

### requirement-workflow-admission-and-concurrency

The workflow must admit an event before it enters the shared per-pull-request
concurrency group. The admission job must not check out source or receive
write permissions. It must admit non-closed `pull_request_target` events only
for non-draft pull requests whose head repository is the current repository. It
must admit `workflow_dispatch` only when a pull-request number is present. It
must admit `issue_comment` only for pull requests, created or edited comments,
and `OWNER`, `MEMBER`, or `COLLABORATOR` authors whose current or previous body
contains the recognized `/seqlane review`, `/seqlane fixed`, `/seqlane wont-fix`,
or `/seqlane downgrade` command under the existing command-matching rules.

Only admitted review computation jobs may use the
`seqlane-code-review-<pull-request>` concurrency group with
`cancel-in-progress: true`. An irrelevant or
unrecognized comment must not enter that group, cancel an active review, or
queue behind one. A closed `pull_request_target` event must run a separate
no-op cancellation job in the same group so it interrupts active review work
without starting review or publisher steps. The v5 final publisher uses the
separate non-cancelling group defined by requirement-serialized-publication.

## Detailed design or contracts

The following v3 transport description is legacy input only. The v5
publisher places its strict version 5 state block in a collapsed Markdown
details element after the human projection.

The state payload uses compact JSON. The publisher can use a bounded
`gzip+base64` wrapper when direct JSON exceeds the state budget.

The run metrics ledger uses a separate, visible Markdown code block with
start/end markers. Its JSON shape is:

```json
{
  "schemaVersion": 1,
  "runs": [
    {
      "githubRunId": "string",
      "attempt": 1,
      "completedAt": "RFC 3339 timestamp",
      "reviewedRevision": "full Git revision",
      "metrics": {}
    }
  ]
}
```

The ledger must satisfy the existing final-comment byte limit. The publisher
must reject an oversized ledger rather than silently dropping retained runs.
The previous v3 `run`, `runs`, and `runSummary` state fields are not inputs to
the ledger and are not migrated.

Run timestamps and identifiers are audit data. They do not decide publication
order across revisions. The live pull-request head and full Git revisions
decide eligibility. For the same reviewed revision, the GitHub run ID and
attempt prevent an older run from replacing a newer publication. Admitted review computation jobs cancel older computation for one pull
request; the v5 final publisher separately revalidates scope under its
non-cancelling queue. A closed pull-request event uses a separate no-op job in that same
group to interrupt active review work without starting review steps.
Legacy v3 progress-marker cleanup is scoped to the owning run. The v5 path
does not create a progress marker. Irrelevant comments do not enter either
review computation or publication.

The human status and severity labels are deterministic projections of the
validated state. Model output cannot select the final verdict or active
counts.

## Failure and edge cases

- Ignore state from an untrusted comment author.
- Ignore malformed, oversized, or unsupported state.
- Treat a missing, malformed, oversized, or unsupported run metrics ledger as
  an empty ledger without discarding valid review state.
- Reject a publication that would make the visible run metrics ledger exceed
  the final-comment byte limit.
- Do not publish when the live pull request is closed, draft, or ineligible.
- Do not publish when the live head differs from the report head.
- Do not show a predecessor or delta when Git ancestry is not comparable.
- Keep a claimed fix active when verification is absent or uncertain.
- Keep all retained blocking findings before lower-priority history.
- Do not let an irrelevant issue comment cancel or queue an active review.

## Migration

The reader accepts legacy v1 through v4 snapshots only to classify and replace
them. The first scope-capable publication writes the unified v5 state and a
fresh baseline; it does not migrate old findings, dispositions, metrics, IDs, or
checkpoints. V3 numeric identifiers and v4 disposition fields remain legacy
input and are never written as the current incremental state.

## Verification

- Add schema compatibility and malformed-state tests.
- Reject v5 state without a valid manifest reference and digest; distinguish
  that failure from artifact expiry with a valid published checkpoint.
- Test every run-status gate, including valid request-changes results,
  incomplete coverage, uncertain final writes, and failed publication.
- Test two baseline publishers and two updates in the same shared queue.
  Exactly one trusted summary may be created; stale work preserves the prior
  checkpoint and authorized dispositions.
- Test an ambiguous final response followed by exact and mismatched readback.
  No second write occurs while the first effect is unknown; a later run uses
  the live trusted state. Sealed manifest bytes remain unchanged.
- Test queue overflow and cancellation semantics, including coexistence with
  the review computation group and mechanical-disposition writers.
- Add lifecycle transition and stable-identifier tests.
- Add current-head fix-verification tests.
- Add trusted-author and stale-head publication tests.
- Add workflow admission and concurrency regression tests.
- Add ledger parsing, malformed-ledger, duplicate-run, and rendered-derived
  cost tests.
- Execute the exact publisher script with bounded representative state.
- Run the branch workflow against an open pull request.

## Acceptance criteria

- The comment contains a concise human projection and one bounded state block.
- The next review restores validated state from the trusted bot comment.
- Stable finding identifiers survive open, resolved, and reopened transitions.
- A fix claim cannot resolve a finding without current-head verification.
- An old or untrusted run cannot replace the authoritative comment.
- Mandatory limitation notices remain visible after output bounds apply.
- The authoritative comment contains one strict, human-readable run metrics
  ledger and no per-run audit comments.
- A legacy or invalid ledger starts a fresh metrics ledger without changing the
  valid review state.
- Irrelevant comments cannot enter review concurrency, while recognized
  commands and pull-request updates remain serialized per pull request.

## Traceability

- Source proposal: [Seqlane review template](https://github.com/marcolink/seqlane/issues/45)
- Review scope: [spec.incremental-pull-request-review-scope](./2026-09-13-incremental-pull-request-review-scope.md)
- Execution evidence: [spec.review-run-manifest-and-provenance](./2026-09-14-review-run-manifest-and-provenance.md)
- Publication queue: [GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency); [GitHub REST conditional-request limits](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- Delivery: [task.publish-versioned-pull-request-review-comments](../tasks/2026-09-05-publish-versioned-pull-request-review-comments.md)
- Delivery: [task.prevent-comment-triggered-review-cancellation](../tasks/2026-09-05-prevent-comment-triggered-review-cancellation.md)
- Delivery: [task.consolidate-pull-request-review-run-metrics](../tasks/2026-09-06-consolidate-pull-request-review-run-metrics.md)
