---
id: task.effect-v4-integrate-codex-activity-limits
title: Integrate Codex activity limits
status: completed
owners:
  - core
created: 2026-10-22
updated: 2026-10-23
upstream:
  - spec.effect-v4-execution-and-operations
  - spec.codex-app-server-adapter
  - task.effect-v4-optimize-policy-clocks
supersedes: []
---

# Integrate Codex activity limits

## Objective

Bring main's activity-retention correction into the Effect migration branch without losing native coordination or observability.

## Upstream requirements

Adopt commit `6512cf84fe011831b455704f161c8de2cf8d7bb2` from [PR #181](https://github.com/marcolink/seqlane/pull/181). The Codex adapter specification owns the activity budget. The Effect execution specification owns runtime integration and canonical observations.

## Documentation impact

Classification: contract change on this branch, adopting main's existing correction.

- PRD, RFC and ADR: no change; architecture and product scope stay unchanged.
- SPEC: merge the Codex retention contract while preserving current Effect ownership. The execution contract remains unchanged; activity retention does not shorten accepted canonical observations.
- TASK: create this bounded integration task; reconcile the earlier Codex task's delivery evidence.
- Nearby docs: merge the Codex README and public adapter guide changes.

## Scope

Merge main's limits correction, its tests and documentation. Resolve conflicts against current Effect services and Deferred coordination. Preserve the completed-item limit and individual message bound. Activity truncation must not abort a valid turn or bypass cancellation, deadlines or approval handling.

## Out of scope

Unrelated main changes, dependency upgrades, provider calls, public workflow or wire schema changes, merge to main and registry publication.

## Implementation plan

Tracer: more than 1,024 small fragments still produce the valid final result. Then verify both activity budgets emit one truncation notice and omit further activity while execution and canonical observation handling continue.

Merge the requested main commit without rewriting existing task commits. Preserve both branches' assertions when resolving conflicts. Use a fresh implementation session, review the final diff, run focused checks and all root gates, reconcile documentation, then create one integration commit.

## Affected areas

Codex activity reduction, adapter regression tests, public adapter guide, package README and canonical Codex documents. Final compiled CLI verification also covers cancellation during process-ownership registration; the worker must drain that handoff before shutdown.

## Verification

Run test mapping before tests. Retain main's fragmented-text, mixed-activity, event/byte truncation and post-truncation safeguard cases. Retain migration tests for native context, cancellation, exact failure causes and session lifecycle. Use controlled peers only.

Run frozen install, docs validation, typechecks, all tests, lint, all builds, formatting, Nx sync and diff checks. Verify installed archives, compiled CLI, Actions, zero retired evidence and final exact-head CI. Confirm main's requested commit is an ancestor of the migration head and the PR has no remaining integration conflict.

## Completion criteria

Main's correction and the Effect migration coexist. All required assertions pass. Native context and complete canonical observations remain intact. Documentation matches the resulting behavior. One reviewed integration commit records the task.

## Outcome

The integration adopts main's separate 65,536-event and 8,000,000-byte activity
budgets. Crossing either budget clears retained activity and emits one explicit
truncation notice; the valid turn continues. The 1,024 completed-item and
1,000,000-byte individual-message limits remain enforced after truncation.
Deadlines, cancellation and approval handling remain effective.

Conflict resolution preserves owning Zod validation and native Effect
coordination. Truncation clears the migration's open-activity set. Successful
canonical observations now retain the complete native turn snapshot, including
all accepted message fragments, independently of the activity display budget.

Final compiled CLI verification exposed a pre-existing cancellation race:
process cleanup could finish while ownership registration still awaited the
supervisor's acknowledgement. The worker now drains that registration through
the existing bounded native Effect timeout before releasing confirmed stopped
processes. A timed-out drain cannot start a later release. Controlled SIGINT and
SIGTERM tests preserve actual child exit, one terminal cancellation event,
status 130 and absence of supervision failure. The delayed-acknowledgement tests
fail with the previous implementation.

Local verification on Node 24.16.0 and pnpm 10.33.0 passes frozen installation,
358-document validation, 624 test mappings, typechecks, all 20 project test
suites, lint, builds, formatting, Nx sync and diff checks. Focused evidence
includes 100 Codex tests, nine telemetry/canonical-metrics tests, 39 runtime
ownership/runner/process tests and 119 compiled CLI tests. The unit and compiled
cancellation regressions fail with the previous implementation.

Static contract checks report no incompatible callers or public signature
change. Quality diagnostics retain fixture/symbol churn and minor class growth;
the activity reducer grows from 127 to 138 lines. These diagnostics remain
visible without suppressions and are not reported as passing quality gates.

Final artifact verification passes fresh uncached builds for all 23 packages,
the 119-test compiled CLI suite, eight installed archives, all six Action
main/post lifetimes and foreign-process survival checks, workflow lint,
documentation-tooling tests, version dry-run and positive-version package and
publish dry-runs in an isolated snapshot. No registry, tag or repository-version
writes occurred. Source and distribution scans cover 1,302 source files,
1,253 generated files, eight archives and 199 unique production dependencies,
with zero retired integration evidence. No manifest or lockfile change was
needed.

### Rebase onto next, 2026-10-23

The user retargeted PR #180 to `next` and requested a rebase. The rewritten task
chain starts at `173e256cf237b35c4d878bf9c48d3fe294001f82`, which already contains
main's activity correction. The original integration merge's own changes are
replayed as a normal final task commit, so no limits, observation or ownership
repair is lost. All application and library contents match the earlier verified
`2279357` checkpoint byte for byte.

Conflict resolution retains next's beta versioning, explicit npm `next` tag,
shared publication queue and branch-advance checks. Publication still requires
both quality and hosted Action jobs. The release guide and distribution spec
state both gates. Documentation impact is implementation-only integration of
existing contracts; product requirements and architecture decisions are
unchanged. Earlier commit IDs and CI links remain historical checkpoint
evidence; exact rebased-head verification is tracked in PR #180.

Rebased-tree verification passes the complete root gate, 359-document
validation, 624 test mappings, 119 compiled CLI tests, eight installed archives,
all six Actions and 16 controlled release tests. Workflow lint and documentation
tooling pass. The native Nx beta-version preview succeeds. Isolated package
and publish dry-runs pass for all eight stable and eight beta packages; every
beta publication uses tag `next`. Source and distribution scans cover 1,304
source files, 1,253 generated files and 199 unique production dependencies,
with zero retired integration evidence. No repository versions, tags or registry
data changed. Static comparison reports no blocking findings, with three minor
line-count increases in release/workflow tests and configuration. Exact rebased
head CI and remote delivery remain recorded separately in PR #180.

## Delivery state

Implemented and locally verified on `feat/effect-v4-migration`. The original integration
merge retained main commit `6512cf84fe011831b455704f161c8de2cf8d7bb2` as an
ancestor. The user-requested rebase onto `next` preserves all 21 feature task
changes in a linear chain. Main's correction remains an ancestor through next. Exact-head CI and remote
branch delivery are tracked in
[draft PR #180](https://github.com/marcolink/seqlane/pull/180).
No default-branch merge or registry publication is claimed.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [spec.codex-app-server-adapter](../specs/2026-09-12-codex-app-server-adapter.md)
- [task.effect-v4-optimize-policy-clocks](./2026-10-22-effect-v4-optimize-policy-clocks.md)
- [Main activity correction, PR #181](https://github.com/marcolink/seqlane/pull/181)
