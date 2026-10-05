---
id: task.standalone-cli-parity
title: Preserve Current CLI Capabilities in PR 131
status: in-progress
owners:
  - core
created: 2026-10-04
updated: 2026-10-04
upstream:
  - spec.standalone-cli-runs
  - spec.adapter-cli-flags
  - spec.classifier-tasks
supersedes: []
---

# Preserve Current CLI Capabilities in PR 131

## Objective

Rebase PR 131 onto main revision `ea6d2f2` and apply approved review fixes.
Preserve current capabilities and measured performance. Retain the supervised
worker execution path and its cancellation and private configuration contracts.
This approved task replaces the execution plan for the cancelled cutover;
it does not reopen the old in-process execution approach.

## Scope

- Separate input preparation, worker execution, and final-result mapping.
- Reuse workflow identity and result builders across worker and hosted callers.
- Remove unused recording cleanup and keep hosted cleanup with its owner.
- Preserve Codex, OpenCode managed/external modes, classifier configuration,
  dotted input, task deadlines, complete observations, and detailed activity.
- Propagate managed OpenCode authentication through native HTTP requests.
- Preserve JSON isolation, serialization phases, explicit stdin cancellation,
  package exports, installation, and current command names.
- Verify migrated fixture and read-context callers against current main.
- Restore adapter-backed compiled CLI regression coverage.

## Exclusions

- Model catalog caching (SEQ-PR131-010).
- Changes to unrelated workflows, releases, public DSL, or hosted behavior.
- Removal of worker supervision or private classifier credential capture.

## Verification

Run mapping before tests. Verify a deterministic compiled CLI run first:
correct result, no model calls, no adapter startup, and no run persistence.
Then verify managed/external OpenCode, Codex, classifier-only and mixed runs,
errors, both signals, supervisor disconnect, event delivery, and owned cleanup.
Run typecheck, lint, build, formatting, documentation, and package checks.
Compare repeated equivalent workloads against the pinned main revision.
Investigate reproducible timing, memory, event, or request-count regressions.

## Outcome

The PR branch retains main's worker supervision, adapter modes, classifier
connection capture, detailed events, and package exports. Input preparation,
worker orchestration, and outcome mapping now have separate owners. Hosted and
worker callers share workflow-identity result builders and best-effort cleanup.
Managed OpenCode requests use the owned service credential throughout.

Local verification passed the full repository test command (20 projects;
1,512 Vitest tests plus tooling tests), 52 compiled CLI E2E tests, 325 test
mappings, production builds, lint, formatting, and SDLC validation (371 documents).
The repository typecheck still reports three pre-existing errors in
`libs/action-code-review/src/pr-code-review-example.spec.ts` at lines 1467 and
1532. The same errors were reproduced on pinned main `ea6d2f2`.

Alternating main and branch measurements used six retained samples per workload.
Median elapsed-time changes were JSON -0.2%, dotted input -7.8%, event-heavy +1.0%,
and classifier -2.0%. Memory changes stayed within +1.1%. An additional isolated
managed-service comparison used 16 paired samples: median startup -0.4%, memory
-0.3%, and 14 HTTP requests on both revisions. Event/output counts matched.
These fixtures found no reproducible performance regression; they do not prove
performance for every real provider, workflow, or machine. Catalog caching
remains deferred as approved.

## Delivery state

No target-branch delivery is claimed. A reachable merged result and successful
verification are required before this task establishes delivery.

## Traceability

- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
- [spec.adapter-cli-flags](../specs/2026-09-19-adapter-cli-flags.md)
- [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md)
- [Cancelled cutover](./2026-09-16-standalone-cli-cutover.md)
- [PR 131](https://github.com/marcolink/seqlane/pull/131)
