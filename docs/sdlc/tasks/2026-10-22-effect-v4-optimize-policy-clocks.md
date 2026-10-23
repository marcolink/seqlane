---
id: task.effect-v4-optimize-policy-clocks
title: Deterministic policy timing
status: completed
owners:
  - core
created: 2026-10-22
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-optimize-classifier-client
supersedes: []
---

# Deterministic policy timing

## Objective

Remove duplicated infrastructure through the pinned Effect v4 APIs. Preserve supported behavior and observability.

## Upstream requirements

The active execution and operations spec owns all contracts. Oclif and public/wire Zod stay unchanged.

## Documentation impact

Classification: implementation-only.

- PRD, RFC, ADR and SPEC: no change; existing ownership and behavior apply.
- TASK: create this bounded follow-up after the completed migration.
- Nearby docs: update only changed private service or process descriptions.

## Scope

Replace policy sleeps and redundant fake timing infrastructure with TestClock.layer. Consolidate repeated fixtures only when distinct behavior remains tested. Audit remaining nested roots and manual coordination across all packages. Record before/after production and test size.

## Out of scope

Public API changes, weaker bounds, distributed execution, replay, new provider calls and unrelated dependency upgrades.

## Implementation plan

Tracer bullet: Production policy -> inherited Clock -> deterministic timeout/retry/queue tests.

First verify that path. Expand to the remaining callers only after its integration tests pass. Remove the replaced mechanism. Use a fresh implementation session, review each acceptance criterion, run full gates, then commit this task before its dependent task.

## Affected areas

Runtime, adapter, CLI and Action timing tests; final distributions and measurements

## Verification

Keep OS/socket/process tests real. Run full gates, installed tarballs, compiled CLI, distributions, Actions and CI on the final exact head. Report remaining native API gaps and measured reductions without claiming API-count coverage.

Run test mapping before tests. Run frozen install, docs validation, typecheck, tests, lint, build, formatting, Nx synchronization and diff checks.

## Completion criteria

The tracer and expanded callers pass. Replaced code is removed. Measured scope changes and retained native API gaps have concrete evidence. No behavior or documentation drift remains.

## Outcome

Native `TestClock.layer` now drives asynchronous policy tests. Admission captures
one private native Context before authored Promise callbacks. Classifier work
composes as an Effect; agent deadlines inherit the same Clock. Red/green tests
through real Plans prove that 1,000 ms of queue wait consumes no agent budget,
that cancellation occurs at 99 + 1 ms, and that classifier retry occurs at
199 + 1 ms. Replacing the captured Context with an empty Context fails both
integration proofs. Adapter settlement still gates resource reuse.

The final audit removes redundant classifier roots, tracer pairs, Exit wrappers,
signal waiters and test-only execution facades. Shared abort waiting preserves
raw failure identity and removes listeners even when abort occurs during
registration. CLI telemetry allocates collectors and metrics per execution;
rerunning the same Effect cannot mutate an earlier result. Three service Actions
share native FileSystem validation in the existing lifecycle package. No new
dependency or public contract is introduced. Private classifier test support is
excluded from release archives by the existing packaging rule.

Policy timing uses native layers instead of a handwritten eight-method Clock,
closed-scope test clocks and asynchronous global fake timers. OS, socket and
subprocess tests remain real. One synchronous observation-overrun test retains a
narrow fake-clock seam: its non-yielding callback cannot run asynchronous
`TestClock.adjust`. A separate monotonic-only test preserves that budget proof.
Compiled trace tests now cover both controlled OpenCode and Codex peers, with
full parent correlation, canonical observations, logs and metrics. There are no
provider requests in these checks.

Final hosted CI exposed a Linux process-exit race in the ACP null activity-sink
regression. Reading `/proc/<pid>/stat` can return `ESRCH` when the peer exits
after the file opens. The owning schema now recognizes `ENOENT` and `ESRCH` as
disappearance. Initial identity capture remains strict. Cleanup still requires
read-only process-group absence; active descendants and metadata uncertainty
never authorize a signal.

Four deterministic identity cases retain permission/I/O uncertainty and prove
that absent identity cannot authorize signaling. The existing real ACP cases
keep exact null/terminal causes and callback ordering. An extra Linux-only case
forces the read error after actual peer exit and asserts that the seam ran.
A cached Linux Node 24.21 public-API probe passes with the fix and reproduces the
exact hosted failure chain with the original schema. Authoritative local gates
use Node 24.16.0. No dependency or image setup was added.

The API audit covered the 369-module catalog, selected detailed APIs, pinned
4.0.5 source and executable probes. It does not claim that every overload was
read or that unused API count measures quality. All 23 packages were checked;
pure contracts, transformations and Ink/React boundaries retain their appropriate
interfaces. Remaining native gaps are concrete:

| Retained boundary              | Native gap                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded OTLP export            | Item-count batches, unbounded acknowledgements, hidden failures and incomplete joining of preexisting exports do not satisfy byte limits and shutdown acknowledgement. |
| Classifier response validation | TypeSafe parsing drops provider extras and changes score/legend semantics. Native text decoding lacks fatal UTF-8 and required EOF flushing.                           |
| Verified OS ownership          | Automatic process-group signals lack the required birth identity checks. Adopted residents, IPC handoff and exact socket ownership need narrow OS edges.               |
| Admission and event policy     | Queue storage flush is not sink acknowledgement. Count bounds and weighted permits do not supply byte limits or atomic FIFO session/workspace policy.                  |

Native services, transactions, waiting, scopes, streams, HTTP and clocks implement
the machinery beneath those domain rules. History inspection still never replays
uncertain external actions.

Measured TS/JS scope is `apps`, `libs`, `actions` and `workflows`. Test support,
fixtures and controlled SDK servers count with tests. Evaluation sites include
context-preserving `runPromiseWith` and `runForkWith`; a renamed root is not a
removed root.

| Measure                | Original migration head `9be9df0` | After seven optimization tasks | Change |
| ---------------------- | --------------------------------: | -----------------------------: | -----: |
| Production lines       |                            67,818 |                         67,143 |   -675 |
| Test and fixture lines |                            73,492 |                         75,094 | +1,602 |
| Combined code lines    |                           141,310 |                        142,237 |   +927 |
| Evaluation call sites  |                               131 |                            109 |    -22 |
| `new Promise` sites    |                                28 |                             10 |    -18 |

This task alone removes 114 production lines and adds 501 test/fixture lines.
Total code grows; production shrinks. Renaming the existing 24-line classifier
fixture is not counted as production removal.

All ten root gates pass on Node 24.16.0: frozen install, 357-document validation,
622 test mappings, typechecks, full tests, lint, build, formatting, Nx sync and
diff checks. Final verification freshly builds all 23 packages, passes all 117
compiled CLI tests with zero skips, consumes eight installed archives outside
the checkout, and checks all six Action main/post lifetimes. It preserves
foreign processes, zero-model fixtures, denied publication writes and unchanged
Git state. Source and distribution audits report zero retired evidence across
1,301 source files, 1,253 generated files, eight archives and 199 unique production
dependency nodes. Workflow lint and documentation-tooling tests pass.

Versioning dry-run and isolated positive-version package/publish dry-runs pass
for all eight release packages. They change no repository version, tag or
registry data. Production dependency audit reports zero known vulnerabilities;
77 existing development findings retain the same advisory IDs. No dependencies
change in this task. Local logs are retained under
`/private/tmp/seqlane-effect-v4-gates/opt-acp-repaired` and
`/private/tmp/seqlane-effect-v4-gates/opt-final-delivery`.

Structural reports remain visible without suppression. Runtime short-horizon
churn and a small standard Promise-boundary clone remain; name-based static test
reach is incomplete. These diagnostics are not claimed as passing gates. Actual
caller regressions and the complete behavioral suites provide the evidence.

Documentation sync: implementation matches the active spec. Runtime and lifecycle
READMEs, this outcome and indexes are updated. Two earlier outcomes now correctly
identify their historical skip as the duplicate Codex trace case. No required
contract or documentation drift remains.

## Delivery state

Implemented and locally verified on `feat/effect-v4-migration`. The task commit
and final exact-head CI in [draft PR #180](https://github.com/marcolink/seqlane/pull/180)
establish feature-branch delivery. No default-branch merge or registry publication
is claimed.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-optimize-classifier-client](./2026-10-22-effect-v4-optimize-classifier-client.md)
