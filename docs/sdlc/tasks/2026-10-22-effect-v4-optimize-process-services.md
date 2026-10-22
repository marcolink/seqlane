---
id: task.effect-v4-optimize-process-services
title: Native process services
status: completed
owners:
  - core
created: 2026-10-22
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-optimize-transactional-admission
supersedes: []
---

# Native process services

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

Use ChildProcess/ChildProcessSpawner and scoped streams for routine process lifecycle where behavior remains compatible. Retain narrow native seams for IPC, process identity and detached Action residents. Remove duplicate routine mechanisms, not safety policies.

## Out of scope

Public API changes, weaker bounds, distributed execution, replay, new provider calls and unrelated dependency upgrades.

## Implementation plan

Tracer bullet: Adapter/Action process launch -> stream/readiness -> owned shutdown and identity confirmation.

First verify that path. Expand to the remaining callers only after its integration tests pass. Remove the replaced mechanism. Use a fresh implementation session, review each acceptance criterion, run full gates, then commit this task before its dependent task.

## Affected areas

libs/acp; libs/codex; libs/opencode; libs/action-service-lifecycle; libs/action-merge-conflict-resolution; actions/ripwire-server; apps/cli

## Verification

Real child tests must prove exit, descendants, output bounds, foreign-process survival and finite uncertain-cleanup failures. Run actual hosted Actions for changed bundles. Check Snyk and exact pins before dependency changes.

Run test mapping before tests. Run frozen install, docs validation, typecheck, tests, lint, build, formatting, Nx synchronization and diff checks.

## Completion criteria

The tracer and expanded callers pass. Replaced code is removed. Measured scope changes and retained native API gaps have concrete evidence. No behavior or documentation drift remains.

## Outcome

Local implementation is accepted on `feat/effect-v4-migration`. All ten
repository gates pass on the repaired snapshot. Hosted Action verification
is the post-push acceptance gate. No default-branch delivery is claimed.

### Native services and removal

The resident anchor now launches its service and sentinel through pinned
`ChildProcess` / `ChildProcessSpawner` services. Its scoped children inherit the
anchor's process group. Detached parent IPC, validated adoption, persistent
identity, and post cleanup remain in the existing lifecycle policy. The main
scope cannot terminate a resident after its acknowledged handoff.

Ripwire socket-query commands use native process streams, exit waits, timeout,
and scoped shutdown. Git and Docker share one byte-bounded native stream
collector. ACP and OpenCode logs use native stream consumers. A small private
`observeChildLifecycle` bridge translates Node spawn/error/exit callbacks once
into Deferred effects. It adds no launch, retry, queue, or signaling framework.
The replaced callback collectors, duplicate exit promises, timers, and startup
wait implementations are removed.

Git and Docker start both stream readers before asynchronous identity capture.
Node drains unread child pipes after exit. Delayed readers can lose output from
fast commands. A real Git regression delays identity capture until group absence;
the tracked-path reader must still return the complete path. Identity capture and
assignment remain uninterruptible and finish before cleanup can release ownership.

ACP cleanup composes native effects directly into its scope finalizer. No nested
`runPromise` starts its policy waits. Windows cleanup requires both process-tree
absence and the raw child's exit within finite deadlines before confirming close.
OpenCode retains its finite raw-child exit join after forced Windows termination.

### Retained seams and caller dispositions

| Caller                                                                                                    | Disposition and evidence                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `libs/acp/src/{transport,process}.ts`                                                                     | Node handle and SDK writable bridge remain. Native stream reads, scope, identity confirmation and bounded waits own lifecycle. SDK integration tests exercise true EOF, initialization cancellation, malformed updates and complete observations.                                                      |
| `libs/codex/src/transport.ts`                                                                             | Existing bounded stdio protocol seam remains. `respond` is synchronous; requests must preserve abort-during-write and tombstone semantics. The pinned native stdin Sink waits for backpressure drain without exposing the per-write Node callback. A replacement would require another outbound queue. |
| `libs/opencode/src/{service,service-process}.ts`                                                          | Native scoped log streams replace data listeners. Birth-identity-aware launch/cleanup remains Node-owned. Real child tests cover readiness, credentials, endpoint matching, byte bounds, registration, cancellation and foreign-process survival.                                                      |
| `libs/action-service-lifecycle/src/lifecycle.ts`                                                          | Parent Node spawn/IPC and resident handoff remain. A scoped native handle cannot replace IPC adoption or persistent main-to-post ownership. Existing real resident tests cover readiness, cancellation and cleanup.                                                                                    |
| `libs/action-service-lifecycle/src/process-anchor.ts`                                                     | Native process services replace routine sentinel/service spawn and exit machinery inside the resident.                                                                                                                                                                                                 |
| `libs/action-merge-conflict-resolution/src/{git-process,docker-cli,opencode-process,opencode-archive}.ts` | Native streams, scopes and waits replace routine callback machinery. Node handles remain for verified tree cleanup and leader-only signaling when identity acquisition fails. Existing unknown-group retention and descendant tests remain.                                                            |
| `actions/ripwire-server/src/socket-ownership.ts`                                                          | Native process command service replaces command timers, output listeners and exit listeners. Existing endpoint parsing and birth-identity checks remain.                                                                                                                                               |
| `actions/ripwire-server/src/{port,readiness}.ts`                                                          | Narrow socket seams remain. Readiness checks the connected socket's remote tuple while ownership is verified. A generic HTTP client does not expose that connected-socket ownership hook. Port probing already closes its temporary listener.                                                          |
| `apps/cli/src/owned-process-supervision.ts`                                                               | Existing Effect-owned bounded supervision and private IPC acknowledgment policy remain. No routine launch implementation exists here.                                                                                                                                                                  |
| `apps/cli/src/standalone-execution-preparation.ts`                                                        | No process launch exists here. Input-file/stdin validation is outside this process-services change.                                                                                                                                                                                                    |
| `libs/runtime/src/runtime/local/effect-process.ts`                                                        | Existing native argv-task implementation remains, as required by the active spec. Fresh scoped task execution has a different ownership contract from retained service files and main-to-post leases.                                                                                                  |

The pinned Node spawner registers an unconditional nonzero-exit process-group
signal before application identity policy (`NodeChildProcessSpawner.ts`,
`spawnCommand`). `unref` suppresses normal scope release but does not remove that
exit listener. Therefore it cannot replace identity-sensitive service launch
without weakening an existing failure contract. In the existing extractor
regression, identity capture fails, the leader closes, and an unverified resistant
descendant survives. The caller must retain files and report uncertainty. A new
real-child regression adds a leader that exits with code 7 on SIGTERM and checks
that neither the unknown descendant nor an unrelated foreign child receives a
group shutdown. Native automatic signaling violates that contract. Leader-only
Node signaling preserves it; missing identity permits only read-only proof of
group absence.

The installed `effect@4.0.5` and `@effect/platform-node@4.0.5` source and official
[command](https://effect.website/docs/v4/api/effect/process/ChildProcess) and
[spawner](https://effect.website/docs/v4/api/effect/process/ChildProcessSpawner)
APIs were inspected. New direct platform-node declarations use the existing exact
4.0.5 pin. Snyk's package listing reported latest and latest non-vulnerable 4.0.5
with no known direct issues; no dependency upgrade was introduced.

### Verification and measurement

Focused verification passed:

- Test mapping: 610 mappings; focused library/spec typechecks; changed-source lint;
  source/distribution runtime-boundary audit; SDLC validation; diff check.
- Resolver process/Git/Docker/extraction suites: 57 tests. ACP SDK subprocess
  parity: 24 tests. OpenCode service: 11 real-child tests. Resident lifecycle:
  11 tests. Ripwire command/readiness/port and bundle tests: 32 tests.
- OpenCode and zvec-grep bundle loading: three tests each. Resolver entrypoint
  smoke passed with writes disabled and rejected a missing push token.
- Four affected Actions and their eleven build dependencies build. Main, post
  and resident bundles remain ignored. Hosted Action verification uses the
  commit CI after push.
- A delayed-identity regression lost a real Git tracked path before the repair
  and retained it after the repair. All 25 resolver suites pass: 172 tests.
  Library and spec typechecks, focused lint, formatting and test mapping pass.

Production TypeScript line counts compare the task base `1f3ac1137` with this
working tree. The count includes extracted modules and all new helpers; it
excludes tests, documentation, manifests and generated output.

| Area                                                | Before | After | Delta |
| --------------------------------------------------- | -----: | ----: | ----: |
| ACP transport and process                           |    593 |   564 |   -29 |
| Resolver process, collector and archive modules     |    693 |   573 |  -120 |
| Resident anchor                                     |    217 |   178 |   -39 |
| Ripwire socket command                              |    315 |   298 |   -17 |
| Shared private identity lifecycle bridge and export |      9 |    50 |   +41 |
| OpenCode service and process                        |    369 |   423 |   +54 |
| Total                                               |   2196 |  2086 |  -110 |

OpenCode adds explicit birth-identity policy and separates process I/O from
readiness orchestration. Total production reduction is 110 lines (5.0 percent).
Package declarations add the existing platform-node pin to five direct callers;
the production dependency closure stays at 199 packages.

Ripwire edit checks find no incompatible callers for the new command helper,
ACP transport, anchor or socket command. Quality review removed the real
orchestration complexity regression. Remaining reported rows cover known
callback translation size, required identity cleanup branching, history churn,
lockfile importer entries, and name-based false positives. The untouched
`runner-inbox.ts` getter remains used in `runner-client.ts`. No baseline or
acknowledgment file changed to suppress these rows.

All process tests use local fixture programs; no provider/model calls. Local
verification runs on macOS with Node 24.16.0. Windows CIM/taskkill seams remain,
but no Windows execution evidence is claimed. Frozen install, docs validation,
test mapping, typecheck, tests, lint, build, formatting, Nx synchronization and
diff checks pass. Evidence:
`/private/tmp/seqlane-effect-v4-gates/opt-process-final/results.json`.

## Delivery state

Implementation and local gates completed in this task commit on
`feat/effect-v4-migration`. Hosted Action delivery is established separately
by the successful commit CI in [branch history](https://github.com/marcolink/seqlane/actions/workflows/ci.yml?query=branch%3Afeat%2Feffect-v4-migration).
Task metadata alone is not delivery evidence. No default-branch delivery claim.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-optimize-transactional-admission](./2026-10-22-effect-v4-optimize-transactional-admission.md)
