---
id: task.incremental-pull-request-review-scope
title: Implement Incremental Pull Request Review Scope
status: in-progress
owners:
  - core
created: 2026-09-13
updated: 2026-10-07
upstream:
  - spec.incremental-pull-request-review-scope
supersedes: []
---

# Implement Incremental Pull Request Review Scope

## Objective

Make the first published PR review cover the full branch diff. Make later
reviews add findings only for PR files changed since the last published review.

## Upstream requirements

Implement [spec.incremental-pull-request-review-scope](../specs/2026-09-13-incremental-pull-request-review-scope.md).
Preserve the state, lifecycle, trust, and publication rules in
[spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md).

## Scope

- Add strict scope-checkpoint state and a new finding-ID generation.
- Replace a trusted old-version report with a fresh full-diff baseline,
  without carrying its findings or metrics.
- Select baseline or incremental scope from immutable Git revisions and
  the last published trusted checkpoint.
- Collect complete eligible paths and scoped patch evidence with literal Git
  arguments, exact checkpoint commit validation, typed batches, and hard
  cumulative Git, model, and time limits.
- Restrict review lanes to selected scope and gate new findings locally.
- Require each new finding's primary cause anchor to overlap the baseline
  PR change or the current checkpoint-to-head change. Older hunks in a
  newly edited file remain context only. An incremental cause must also
  remain part of the current PR diff, not an imported target-branch edit.
- Persist typed bounded finding evidence and location status. Keep finding
  identity separate from line position without requiring language parsers.
- Assemble one run-local manifest with a sealed item and lane denominator,
  explicit terminal outcomes, provenance, and independent status dimensions.
  Upload one verified final GitHub Actions artifact within a hard size bound.
- Preserve retained finding lifecycle and cumulative verdict.
- Publish one bounded summary and checkpoint together after live target,
  base, head, report, and checkpoint guards pass. Use the shared per-PR
  non-cancelling publication queue.
- Show review mode, scope, and limitations in the human report.

## Out of scope

- A new public Seqlane workflow or runtime API.
- DynamoDB, external storage services, leases, journals, and IAM/OIDC
  coordinator access.
- Cross-run item resume, artifact compaction, and inline finding publication.
- Automatic baseline reset on force-push, retargeting, or state failure.

## Implementation plan

### First tracer bullet: private scope and complete Git evidence

Outcome: a trusted admission produces deterministic scope and complete evidence
through real Git. The current v4 workflow remains separate.

Path: strict ScopeIdentity -> bounded Git port -> pure selector -> grouped
literal scoped diffs -> review batches, local validation batches, and tree metadata.

Risk: path parsing, checkpoint identity, rebases, exclusions, or incomplete
output can silently widen scope or omit evidence.

Evidence: temporary Git repositories cover baseline, incremental, same-head,
rebase, reverted edits, base movement, renames, deletions, binary, mode,
symlink, submodule, and hostile-path cases. Port tests cover missing measurements,
truncation, cancellation, and resource boundaries.

This slice implements the collector against a strict trusted host port.
It rejects absent resource measurements and requires host enforcement before
production use. The existing process API does not provide complete CPU,
memory, or fetch-transfer controls. A production host adapter remains required.
The real-Git test adapter measures child resources but is not a production adapter.

The collector seals complete local evidence before model work. Baseline review
uses the current PR diff. Incremental review uses the checkpoint-to-head diff.
Current-PR evidence stays in separate local validation batches. Each selected
revision range uses one bounded multi-path command, including at most 200
literal paths. Raw records and patch headers must exactly match that inventory.
Whole paths are batched locally. A single path patch above the batch limit
fails closed; hunk partitioning is follow-up work. Both batch groups share
the existing batch, hunk, byte, and execution ceilings.

Excluded from this slice: trusted v5 report classification and transport,
model invocation planning, finding admission, manifests, storage, and publication.
No existing finding or checkpoint changes during this slice.

### Remaining delivery

The private [trusted v5 report admission slice](./2026-09-14-unify-code-review-comment-state.md#next-pr-trusted-v5-report-admission)
is implemented locally on top of PR #176 at `7ce908b`.
It connects strict report classification to this collector. Model and publication
wiring remain pending.

1. Deliver the [production Git host slice](#next-pr-production-git-host-for-v5-admission)
   on top of PR #178. Connect the existing private admission path to enforced
   Git execution and exact-checkpoint fetch. Preserve report classification and
   scope semantics. The test fixture does not satisfy this production boundary.
2. Connect the verified host and admission output to the later v5 computation
   job. Keep the current v4 workflow separate until its replacement is complete.
3. Extend complete batching with deterministic hunk partitioning for paths
   that exceed one batch. Preserve literal paths, complete evidence, shared
   cumulative budgets, and separate review and validation batches.
4. Pass scope, the mode-selected review patch, and retained current-generation
   findings as reference context to configured lanes and synthesis. Send only
   retained findings whose primary causes have verified overlap with new
   changes to history verification. A changed file alone is insufficient. Keep
   current-PR validation batches local to the cause-admission gate. Add the deterministic
   new-finding path and changed-anchor gate, first-observed revision, typed
   evidence and location status, evidence-backed identity, and typed
   comparison outcomes. Reuse the canonical RetainedFinding and evidence schemas.
5. Seal the canonical current-head verification sources separately from the
   discovery denominator. Validate finding, head, path, digest, and location
   bindings before accepting an outcome; record it in the manifest.
   Preserve untouched findings as `not_reviewed` and compute a cumulative
   verdict. Empty scope skips all model work, including history verification
   and synthesis. Do not claim fresh verification for carried findings.
6. Add the Action-owned run-local manifest, sealed item and expected-lane
   denominator, one-to-one terminal outcomes, provenance and trusted rule
   validation. Apply the pinned redaction policy before both persistence sinks.
   Bound final canonical bytes, reserve storage under the canonical aggregate
   caps, upload one GitHub Actions artifact, and reconcile actual stored bytes.
   Validate the canonical ManifestReference and require it in v5 state.
7. Use separate computation, publisher, recovery inspection, and recovery
   dispatch jobs under the canonical publication permissions contract.
   Isolate model workers from GitHub and artifact runtime credentials.
   Register the publisher before queue entry. Route review publishers alone
   through the canonical non-cancelling per-PR queue. Re-read the live report
   and PR after admission. Block every later write while an earlier request
   has an unknown effect. Replay the existing sealed candidate only after
   proving no previous write can complete. Never upload a second manifest.
8. Thread one typed ScopeIdentity through evidence, lanes, finalization,
   artifact, and publication. Re-read target branch, base revision, head,
   report identity, and checkpoint before the final write.
9. Update documentation and run focused, contract, and hosted workflow
   checks. Keep current v4 progress and ledger behavior separate from planned v5.

### Next PR: production Git host for v5 admission

#### Stack and documentation impact

Base: [PR #178](https://github.com/marcolink/seqlane/pull/178), branch
`codex/trusted-review-admission`, inspected at
`f897a641f510485187e384c13491fc8f41c5dc38` on 2026-10-07.
Merge order: #112 -> #176 -> #178 -> this slice.
This slice depends on admission and collector code from the stack.
It is not independently mergeable into `main` before those dependencies land.
The base head was rechecked before implementation and remains unchanged.

Classification: implementation-only.

- PRD: no change. Incremental review behavior stays the same.
- RFC: no change. This is private Action host integration.
- SPEC: no change. Enforce the existing resource, authority, and checkpoint contracts.
- TASK: update `task.incremental-pull-request-review-scope`. This section owns the next bounded slice.
- ADR required: no. No public API, runtime engine, or storage decision changes.

The active scope specification already requires hard host controls.
PR #178 implements admission against `BoundedReviewGitPort`, but supplies only a test Git adapter.
Its Python fixture measures child CPU and memory after execution.
It does not enforce CPU, memory, or fetch-transfer limits during execution.
The current production `runCodeReview` still uses the v4 path.

Required documentation work: retain this task's ownership, then describe verified host requirements in the private Action README.
No product decision blocks this plan. The enforcement mechanism requires the technical proof described next.
If that proof requires different limit semantics, reassess specification impact before implementation expands.

#### First tracer bullet: real admission with enforced local Git

- **Outcome:** a serialized v5 report and a local checkpoint produce complete incremental evidence through the production Git host.
- **Path:** read-only authority pages -> `admitReviewScope` -> `ReviewGitBudget` -> host supervisor -> real Git -> validated admission output.
- **Risk:** the runner cannot enforce and measure all child resources or stop every descendant before returning.
- **Evidence:** a temporary repository excludes an older reviewed hunk from discovery while retaining current-PR validation evidence.
  Wall, CPU, memory, output, and cancellation breaches stop the process tree and return typed failures.
  Both paths make zero model calls and perform zero GitHub or artifact writes.
- **Excluded:** checkpoint transfer, model dispatch, finding admission, manifests, rendering, and publication.

Start with Linux on the Ubuntu VM runner used by the review workflow.
Use one Action-owned supervisor boundary with explicit capability preflight.
Reject unsupported hosts or missing controls before starting Git.
Never substitute the fixture adapter, missing measurements, or post-run checks for enforcement.

A cgroup v2 supervisor is the initial candidate, not an established runner capability.
Prove controller access, child placement before execution, group cleanup, and the measurement units on the actual runner.
The [kernel cgroup documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
defines group CPU accounting, memory controls, and whole-tree termination.
`cpu.max` limits CPU bandwidth per period. It does not implement a cumulative CPU-time budget by itself.
Memory accounting also needs an explicit match to the existing port contract.
Do not report sampled RSS or a per-child limit as a proven group limit.
Record enforcement granularity and conservative headroom in the technical proof.
If the mechanism cannot satisfy the required ceilings, fix it before adding fetch or workflow wiring.

Implement the minimum production `run(request)` path after this proof:

1. Resolve the trusted checkout path and validate host options and requests with owning Zod schemas.
2. Run a trusted Git executable with argv arrays and no shell.
   Preserve the collector's literal paths, NUL records, and replacement-object protection.
3. Disable lazy fetch with `GIT_NO_LAZY_FETCH=1` and deny network access for local operations.
   Disable hooks, external diff, text conversion, prompts, and repository-controlled executable helpers.
   Isolate inherited Git configuration and credentials without breaking valid repository object lookup.
4. Install controls before the child executes. Include every helper and descendant in resource accounting and termination.
5. Count stdout and stderr together before retaining bytes. Reject overflow without returning truncated evidence.
6. Return actual wall time, CPU time, peak memory, and transfer usage through the canonical result schema.
   Local transfer is zero because network access is denied.
7. On a breach or abort, stop and reap the complete group before settling the request.
   Release owned pipes, timers, temporary files, and supervisor resources on every exit path.
8. Preserve `ReviewScopeLimitError` fields: resource, observed value, limit, and operation.
   Preserve other typed scope errors and their causes. Missing or malformed measurements block admission.

Reuse `ReviewGitBudget` and `REVIEW_GIT_LIMITS` without adding another cumulative budget.
Requests already contain the remaining command wall, CPU, output, memory, and transfer limits.
The host must enforce those values while work runs, including reduced values on later commands.
If the host needs result validation, export the existing schema for internal reuse.
Do not copy its shape into a second handwritten validator.

Before, in integration tests:

```ts
const admission = await admitReviewScope(
  { pullRequest: frozenPullRequest },
  { authority: githubReadPort, git: fixture.git, admittedAt, signal },
);
```

After, with a proposed private host factory:

```ts
const admittedAt = performance.now();
const gitHost = await createReviewGitHost({ reviewTarget, cgroupRoot, trustedRemote, signal });
try {
  const admission = await admitReviewScope(
    { pullRequest: frozenPullRequest },
    { authority: githubReadPort, git: gitHost.git, admittedAt, signal },
  );
  // Inspect admission.evidence. No model or publication work in this slice.
} finally {
  await gitHost.close();
}
```

The caller captures one admission start time before host setup and authority reads.
Its absolute deadline also cancels authority requests and supervisor setup.
When Git collection begins, retain the original 120-second deadline.
Reuse raw `listIssueComments` pages with explicit pagination completeness.
Do not pass the v4 normalized history or its latest-report selection into admission.

#### Second tracer bullet: bounded exact-checkpoint fetch

**Outcome:** a valid published checkpoint missing locally is fetched once from the trusted repository, then validated by the existing collector.

**Path:** current v5 report -> missing exact object -> `fetchExactCommit` -> metered transport and supervisor -> exact commit validation -> evidence.

**Risk:** Git helpers, remote configuration, redirects, or hidden lazy fetch bypass transfer or process budgets.

**Evidence:** a controlled Git server supplies the missing checkpoint.
The host reports measured transfer bytes, and admission preserves the exact published checkpoint.
Oversized transfer, unavailable objects, stalls, and cancellation fail without a baseline reset or retry.

1. Build the remote URL from trusted repository identity. Ignore the target checkout's remote URLs and URL rewrite rules.
2. Validate the full object ID and fetch only that checkpoint.
   Disable tags, recursive submodules, maintenance, hooks, prompts, and implicit retries.
   Keep fetched objects local without moving HEAD, the index, or the worktree.
3. Meter bytes at the controlled transport boundary while receiving them.
   Include all transport requests in the one fetch allowance.
   Git progress text, final pack size, and disk growth cannot establish transferred bytes.
   Define the counted byte boundary and prove that redirects and alternate routes cannot bypass it.
4. Use the same supervisor and remaining budget as local Git work.
   Enforce the existing 16 MiB transfer and 30-second fetch defaults.
   Stop and reap Git and transport helpers on the first breach.
5. Keep read-only fetch credentials in the trusted transport adapter.
   Do not expose credentials in argv, returned stderr, diagnostics, or target configuration.
6. Let the existing collector repeat commit-type and exact-ID validation after fetch.
   An unavailable checkpoint stays an error. Never substitute a branch tip or a fresh baseline.

The transport design must prove byte enforcement before this tracer is accepted.
No package choice is required by the plan. Any new dependency requires the repository's dependency security review.

#### Third tracer bullet: packaged host on the real runner

**Outcome:** the bundled private host produces admission output on the actual Ubuntu runner with all required controls active.

**Path:** trusted source checkout -> Action build -> admission-only fixture runner -> authority read port -> production host -> evidence or typed rejection.

**Risk:** bundling, helper assets, privileges, controller access, or runner image changes invalidate local enforcement evidence.

**Evidence:** a hosted fixture run proves incremental admission, exact fetch, cancellation, and resource rejection.
Record the runner image, Git version, controls, measured usage, and cleanup result.
Use temporary repositories and fixture reports. Grant no comment or artifact write access and supply no model credentials.

Add a narrow admission-only verification path rather than switching `runCodeReview` to v5.
Reuse the existing raw GitHub client seam for an optional read-only authority smoke check.
Require two matching inventories, bounded to four requests, with retries disabled.
Thread the single deadline and abort signal into those requests.
Build all host code and helper assets from the trusted source checkout.
Verify asset resolution from a different working directory and include assets in Nx build inputs and outputs.
Generated bundles remain ignored. This gate proves the host, not hosted v5 review publication.

#### Affected areas and test gates

- New cohesive host, process supervision, and fetch transport modules in `libs/action-code-review/src/`.
  Keep process control separate from Git policy, byte metering, and platform result parsing.
- `review-git-budget.ts`: reuse the request, accounting, and canonical result schema.
- `review-scope-errors.ts`: reuse typed limit failures and preserve their cause boundaries.
- `review-scope-admission.ts` and `review-scope-evidence.ts`: consume the existing host seam without changing scope selection.
- `index.ts`: export the intentional private host factory and lifecycle only.
- Action build configuration and a narrow hosted fixture invocation: package and verify the host and required assets.
- The private Action README: document supported runner capabilities, cleanup, trusted remote input, and remaining v5 delivery gaps.

Run `pnpm run test:mapping` before tests.
Colocate host tests. Cross-module admission tests declare valid `@test-scope` paths.
Use real Git for baseline, incremental, same-head, hostile paths, SHA-1, and SHA-256 cases.
Preserve separate discovery and validation batches and zero patch commands for empty scope.
Reject malformed v5 and unstable authority before any Git request.

Supervisor regressions cover combined output at the limit and one byte over, wall and CPU exhaustion, memory breach, and cancellation.
Include a child that forks and ignores termination, a child whose parent exits first, and concurrent cleanup races.
Prove no surviving descendant and no missing, fabricated, or cross-command measurements.
Cover reduced limits on later commands, admission deadline expiry, unsupported controls, and malformed supervisor output.
Transfer tests cover the exact byte boundary, one byte over, slow responses, refused exact IDs, and hostile remote configuration.
Reject a partial clone's attempt to fetch during local work.
Use deterministic fixtures for exact accounting boundaries and live processes for actual enforcement.

After focused tests pass, run the affected Action library suite, source typecheck, test typecheck, scoped lint, and formatting.
Build affected Action bundles and run entrypoint-loading checks.
Run `actionlint` for any new or changed verification workflow.
Compare typecheck failures with the exact stack base. Do not waive new errors.
Run `pnpm docs:index`, `pnpm docs:validate`, and `git diff --check`.
Complete the hosted supervisor and transport gates before claiming the production host is verified.

#### Completion and next boundary

Completion requires admission through the production host and real enforcement evidence for every required limit.
All errors preserve the prior report and checkpoint. No model, comment, or artifact write occurs.
After implementation, record commits and hosted evidence in Outcome and Delivery state.

Next: complete oversized-path batching where required, then connect admitted discovery evidence to lanes and local finding admission.
Empty scope still skips models. Manifests and guarded publication remain later slices.

## Affected areas

- `libs/action-code-review/src/contracts.ts`
- `libs/action-code-review/src/review-history.ts`
- `libs/action-code-review/src/workflows/publication-workflow.ts`
- `workflows/code-review/contracts.ts`
- `workflows/code-review/workflow.ts`
- `workflows/code-review/tasks/review-history.ts`
- `workflows/code-review/tasks/review-git-evidence.ts`
- `workflows/code-review/tasks/review-lanes.ts`
- `workflows/code-review/tasks/review-synthesis.ts`
- `workflows/code-review/tasks/review-finalization.ts`
- `libs/action-code-review/src/publication-*.ts`
- `libs/action-code-review/src/review-run.ts`
- `libs/action-code-review/README.md`
- `.github/workflows/seqlane-code-review.yml`

## Verification

- Run pnpm run test:mapping before focused tests.
- Run old-version replacement, malformed-input, schema-matrix, literal
  pathspec, exact-object, exclusion, typed-batch, aggregation, cumulative
  budget, finding-ID isolation, typed-evidence, comparison-outcome, rule-source,
  and workflow-admission tests.
- Prove every configured batch lane has a validated result before coverage
  can be complete; missing or failed lanes preserve the old checkpoint.
- Test a file edited twice: a candidate anchored only in the earlier PR
  hunk receives no new ID, while a candidate anchored in the C-to-H hunk
  and still in the PR diff can receive one. Cover imported target changes,
  added, removed, zero-hunk tree-entry, and no-change evidence; validate
  the cause locally before ID allocation.
- Test two baseline publishers and concurrent report updates in the same
  shared queue. Test stale guards, queue overflow, safe replay, duplicate dispatch,
  and cancellation during a write. Prove that one authoritative comment remains.
- Test explicit job permissions and the model worker's environment and storage
  boundary. Prove only the trusted publisher can write the bot comment.
- Test byte-stable manifests, pre-upload size failure, one verified artifact,
  explicit 90-day retention, policy rejection, artifact expiry, and
  missing-reference refusal without a baseline reset.
- Test canonical aggregate storage admission at both caps and one byte over.
  Include retained published artifacts, outstanding candidates, controls,
  reservations, concurrent admissions, incomplete inventory, uncertain upload,
  publication without released bytes, safe cleanup, and confirmed expiry.
- Test canonical model reuse, strict references, owner-link consistency, and
  early cancellation without a promised manifest. Test representative redaction
  fixtures in both sinks and hash-and-location-only evidence for unsafe excerpts.
- Test verification against sealed current-head sources. Reject another
  finding's evidence, stale revisions, unsealed paths, false digests or lines,
  and unsupported absence. Cover deletion, rename mapping, tree entries,
  redacted excerpts, uncertainty, and verification with no discovery scope.
- Run pnpm docs:index, pnpm docs:validate, formatting, and git diff --check.
- Run the hosted workflow on an open PR for a baseline, a changed-file
  follow-up, and a same-head follow-up. Inspect authoritative state and
  verify that unchanged-file findings receive no new ID.

## Completion criteria

- All acceptance criteria in the upstream spec are demonstrated by focused
  tests and the hosted run.
- A partial or failed run preserves the prior published checkpoint.
- Review output and report state do not claim a full-branch re-review on an
  incremental run.

## Outcome

The first private scope collector slice is proposed in
[PR #176](https://github.com/marcolink/seqlane/pull/176), based on PR #112 at `6688815`.
It has no production caller. Focused real-Git and port tests provide local evidence.
The production host was added in the follow-up slice described below. Other v5 delivery work remains pending.

Incremental review input is the checkpoint-to-head diff. Current-PR validation
is separate. A real-Git test covers 200 incremental paths with two patch
commands, complete discovery and validation inventories, and no earlier PR
patch in discovery input. File-type transitions retain both patch blocks.

A follow-up regression proves that older reviewed hunks in an edited file and
previously reviewed unchanged files stay out of incremental discovery input.
The focused collector suite passes 25 tests. The v5 contract carries untouched
findings as `not_reviewed`, schedules verification only for locally established
cause overlap, and skips all models for empty scope. Cause selection and
orchestration enforcement remain pending v5 delivery work.

Follow-up fixes validate the repository's storage hash format and require each
base, head, and checkpoint to resolve to its admitted full commit ID.
Real-Git regressions reject 40-character SHA-256 prefixes and accept full
SHA-1 and SHA-256 IDs. Command and checkpoint-fetch methods are explicit and
share one execution budget; 13 budget tests cover their routing and accounting.

Local verification passes the full Action library suite: 15 files and 150 tests.
Source typecheck, test mapping, formatting, and SDLC validation pass.
The test typecheck retains three errors in the untouched
`pr-code-review-example.spec.ts` at lines 1467 and 1532.
The current v4 workflow has no collector call and keeps its existing contracts.
Ripwire flags two short command-status helpers shared across Action packages.
The packages keep separate helpers because their ports and domain errors differ.

The follow-up private admission slice now validates shared v5 schemas and
bounded hidden transport before collecting Git evidence. Complete authority
lookup rejects duplicate reports, malformed records, and incomplete pagination.
All v1–v4 payloads are ignored and select the full current PR diff. Valid v5
uses its published `reviewedRevision` and preserves retained findings as reference
context. Malformed or future state blocks before collection.
The production v4 caller, model admission, and publication remain unchanged. The following slice supplies the private bounded host.

The production Git host slice implements `createReviewGitHost` and
`admitReviewScopeWithGitHost`. The latter owns the single admission deadline,
authority cancellation, and host cleanup. Local Git is restricted to collector
commands with isolated credentials, disabled helpers, literal pathspecs, and
inherited network denial. Linux cgroup controls enforce memory and contain all
descendants. CPU uses a one-core quota, 1 ms monitor, and 5 ms conservative
headroom; final accounting rejects scheduling overshoot. Errors retain actual
usage and never substitute missing measurements or successful truncated output.

Exact checkpoint fetch uses metered HTTPS response bodies across both requests.
The byte boundary excludes HTTP headers, TLS/TCP overhead, and outgoing request
bytes. Redirects, encoded responses, proxy routing, and target remote rewrites
are blocked. A supervised pack installation leaves HEAD, index, and worktree
unchanged. SHA-1 and SHA-256 integration tests preserve a missing non-ancestor
published checkpoint without retries or a baseline reset.

Local Linux verification passes using the packaged host from outside the
checkout: Git 2.54.0, Python 3.14.8, arm64, kernel 7.0.14-linuxkit.
The fixture proves baseline, incremental, same-head empty scope, literal hostile
paths, exact fetch, combined output boundaries, CPU and memory breaches, wall
expiry, cancellation, local network denial, and detached descendant cleanup.
No workload cgroup or descendant survives. The narrow hosted verification
step is part of existing CI; actual Ubuntu runner evidence is pending.

The first Ubuntu run exposed a delegation gap: a launcher outside its owned
subtree cannot move children through the root-owned common ancestor.
The hosted launcher now enters a separate delegated leaf, then drops to the
normal runner identity. Cleanup uses trusted privilege to remove the owned
root from its root-owned parent. The same failure is reproduced locally with
an unprivileged launcher outside the subtree; the corrected path is verified
separately. This changes runner setup, not the scope or budget contract.

The host implementation is committed locally as `7ab52f1`, based on PR #178.
Local checks pass: 29 library test files and 330 tests, four Action tests,
Action bundle loading, source typecheck, scoped lint, formatting, test mapping,
workflow actionlint, SDLC validation, and diff checks.
One Linux-only Vitest test is skipped on macOS; the packaged Linux gate runs
those live cases separately. The three test-typecheck errors are reproduced
unchanged on the exact stack base `f897a641f510485187e384c13491fc8f41c5dc38`.

## Delivery state

Partial local implementation. No target-branch delivery claim is made here.

## Traceability

- Contract: [spec.incremental-pull-request-review-scope](../specs/2026-09-13-incremental-pull-request-review-scope.md)
- Host limits: [requirement-complete-evidence](../specs/2026-09-13-incremental-pull-request-review-scope.md#requirement-complete-evidence)
- State and lifecycle: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Execution evidence: [spec.review-run-manifest-and-provenance](../specs/2026-09-14-review-run-manifest-and-provenance.md)
- Publication permissions and recovery: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md#requirement-publication-permissions)
- Host slice dependency: [trusted v5 admission task](./2026-09-14-unify-code-review-comment-state.md#next-pr-trusted-v5-report-admission)
- Host slice stack base: [PR #178](https://github.com/marcolink/seqlane/pull/178)
- Host implementation: [PR #179](https://github.com/marcolink/seqlane/pull/179)
