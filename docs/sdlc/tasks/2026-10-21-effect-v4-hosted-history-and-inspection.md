---
id: task.effect-v4-hosted-history-and-inspection
title: Hosted history, HTTP, MCP, and inspection
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-cli-and-action-cutover
supersedes: []
---

# Hosted history, HTTP, MCP, and inspection

## Objective

Connect one real hosted workflow from HTTP start to events/result/cancel, SQL history, and trace inspection after restart.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Connect one real hosted workflow from HTTP start to events/result/cancel, SQL history, and trace inspection after restart.
- Implement protocol-owned Zod DTOs and migrate every consumed operational-client operation.
- Use Effect HTTP/SQL/MCP primitives with the same run program and composition-owned adapters.
- Prove the same run path through MCP, including protocol negotiation, admission bounds, and client cancellation.
- Remove `unstable_studio` only after these inspection paths work. Document TUI, replay, host inspection, and optional telemetry viewers.

## Affected areas

`libs/runtime/src/operational-host.ts`, host implementation, protocol DTOs, CLI operational client, and `unstable_serve`.

## Documentation impact

Classification: contract change within the accepted migration.

- PRD and RFC: no requirement change; update delivery evidence after verification.
- SPEC: retain the hosted operation requirements; record the selected endpoint and persistence contracts.
- TASK: this task owns hosted transport, storage, client migration, and inspection parity.
- Nearby docs: update runtime and CLI READMEs, public inspection instructions, and command examples.
- ADR required: no. The accepted migration already owns this architecture change.

### Bounded delivery plan

1. Define versioned Zod DTOs in protocol before implementing the host. Keep workflow, run, event, result, completeness, and trace data engine-neutral.
2. Replace the host with scoped Effect HTTP, SQL, and MCP services. Reuse the common Effect Plan program and composition-owned adapter factory.
3. Use `@effect/sql-sqlite-node@4.0.5` with its compatible `effect@4.0.5` peer. Snyk's exact version page reports no direct vulnerabilities. Use a short explicit busy timeout and short transactions.
4. Preserve useful health and workflow/run paths. Bound admission, request bodies, pagination, observation deadlines, and event queues. Preserve cancellation and original causes.
5. Persist accepted events and correlated inspection before terminal completeness. On restart mark active runs interrupted; never replay external actions. Use a fresh `.seqlane/operations.db`; leave existing databases untouched.
6. Migrate every operational client method to the DTOs and native Effect HTTP/time. Prove HTTP, MCP negotiation/cancellation, restart inspection, malformed input, storage loss, and concurrent runs.
7. Remove the replaced server/storage composition and Studio launcher after replacement evidence passes. Document terminal UI, replay, HTTP inspection, and optional telemetry viewers.
8. Review every acceptance criterion, run the full repository gate and compiled CLI checks, reconcile docs, then commit only this task on the migration branch.

## Verification

host restart inspection, interrupted-run handling, health/readiness, loopback/origin checks, storage failure, trace flush, and MCP integration.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove old host/server/storage composition, Studio launcher, and newly unused dependencies.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

HTTP and MCP now use the common Effect Plan program. The native host provides
versioned Zod workflow, start, status, result, list, event, cancellation, and
trace contracts. Start returns a queued reference. Oclif remains the command
parser. Its scoped serve lifetime owns listening and closes a late acquisition
after interruption without opening a listener.

The Effect SQL service stores canonical events, terminal outcomes, and correlated
inspection in a fresh versioned SQLite database. Related writes are transactional.
One native connection lock prevents another host from recovering live work.
Restart marks unfinished runs interrupted and never repeats their external actions.
Event pages retain whole records within count and byte bounds. Missing prefixes,
interior ranges, and suffixes have explicit gaps without cursor rollback.

Run admission reserves capacity before asynchronous storage work. Four active
runs and sixteen queued runs share native permits. Cancellation joins started
work before releasing capacity, including cancellation during startup or permit
handoff. Shutdown drains pending admissions and runs once. Boxed delivery failures
preserve null and undefined causes. Required event loss during execution reports
failure and incomplete inspection; storage loss after success preserves that
success and reports incomplete inspection. Optional OTLP export cannot overwrite
the task result.

Native HTTP and MCP share loopback/origin validation, a one MiB body limit, and
a ten-second body deadline. Tests cover native MCP negotiation, session and
request cancellation, and truthful failures. The client uses bounded Effect HTTP
reads and native polling schedules. Healthy long runs have no whole-run observation
deadline. SQL dependency loss makes readiness unavailable. Hosted adapter fixtures
retain complete model, tool, and skill observations, falsey JSON values, and trace
correlation after restart.

Removed the replaced host/server/storage implementation and Studio launcher.
Removed newly unused server, SQL, and CLI dependencies. The remaining private
compiler fixtures and engine dependency guards belong to S12 removal. Runtime,
CLI, and root documentation now describe the replacement inspection paths and
intentional history discontinuity.

### Verification state

The full repository gate passes frozen installation, documentation validation,
all 545 test mappings, complete typechecking, tests across twenty projects, lint,
build, formatting, Nx sync, and diff checks. All 692 runtime tests, 57 protocol
tests, and 127 CLI unit tests pass on Node 24.16.0 with one test worker.

The complete compiled CLI suite passes 116 tests across nine files in 76.08
seconds. One duplicate Codex parameter for the OpenCode-specific trace proof
remains skipped. A separate compiled Oclif host proof retains a falsey result,
thirteen events, and three spans across restart; verifies idempotent cancellation;
rejects a competing database owner; kills the actual host process; and verifies
interrupted inspection without replay. Its execution counter stays at the three
original runs.

Structural review covers all 74 quality-delta rows, including thirteen gating
clone diagnostics. Remaining findings reflect bounded lifecycle orchestration,
contract-owned validation, transport-specific byte reading, direct endpoint
wrappers, generated lock data, and static type/callback resolution limits. A
bounded cohesion pass flattens error mapping and shares query conversion. The
full-run join intentionally differs from invocation cleanup's uncertainty cutoff.
No baseline or acknowledgement files change. The static test map selects 48
suites, covered by the full repository and compiled CLI checks. No zero-debt
claim is made.

Process and crash evidence runs on macOS. No new paid-provider, Windows, or
remote CI evidence is claimed. S11 owns remaining Actions and distribution;
S12 owns complete removal and final release verification.

## Delivery state

Completed on `feat/effect-v4-migration` in this task commit, after S9 commit
`53fb80d`. Evidence is branch-local. Remaining Actions, distribution, complete
removal, and final remote verification remain S11–S12 work.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-cli-and-action-cutover: prerequisite task](./2026-10-21-effect-v4-cli-and-action-cutover.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
