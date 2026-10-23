---
id: task.effect-v4-native-adapters-and-observations
title: OpenCode and Codex with full observations
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-nested-workflows-and-validation
supersedes: []
---

# OpenCode and Codex with full observations

## Objective

Run one model task, tool activity, structured-output repair, checkpoint/fork, and cancellation path for each supported native harness.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Run one model task, tool activity, structured-output repair, checkpoint/fork, and cancellation path for each supported native harness.
- Scope native SDK streams, requests, services, and late completion handling.
- Emit canonical observations and project them through the runtime rather than native adapter engine spans.
- Use safe protocol fixtures plus an authenticated installed-agent smoke test when available.
- Record unavailable credentials as missing live evidence; fixture success alone does not prove the live SDK path.

## Affected areas

`libs/opencode`, `libs/codex`, adapter contracts, runtime invocation context, protocol observations, and TUI detail projection.

## Verification

model/tool/skill values, usage, timing, attempts, correlation, capability errors, and cleanup at CLI and direct-call boundaries.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove old native span projectors and opaque engine-context forwarding after both adapter callers migrate.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Completed after S4 commit `7def353`. Effect owns native adapter scopes, request serialization, stream monitoring, timeouts, and cleanup. Native span projectors and opaque runtime-context forwarding are removed from both adapter callers. Public and wire contracts remain Zod-owned.

Canonical observations retain complete available SDK request and response values, usage, timing, and correlation. Failure and cancellation retain partial native values. Native Codex command and MCP fields follow the installed 0.147.0 protocol schema. Tool activity preserves full metadata, false, zero, empty strings, and null. Tool cancellation publishes terminal activity only after external termination is confirmed. Cleanup errors preserve the original abort reason and late SDK failure, including frozen or primitive reasons. Unconfirmed work retains its admission leases and quarantines its resources.

The installed Codex agent completed an authenticated smoke test with false, zero, and empty-string output values. The OpenCode live call reached its provider but failed with HTTP 401. OpenCode live verification is unavailable; protocol-fixture success does not establish that live model path.

The full repository gate passes frozen install, documentation validation, 493 test mappings, typecheck, tests across 20 projects, lint, build, formatting, Nx sync, and diff checks. All 554 runtime tests, 129 OpenCode tests, 73 Codex tests, and 87 compiled Oclif end-to-end tests pass. The CLI fixtures use public native factories, an actual HTTP SDK peer, and a real stdio subprocess with protocol-valid MCP items. They verify model preflight, structured-output repair, session reuse and fork, full observations, confirmed cancellation, process exit, and no default Seqlane state directory.

The first concurrent gate exposed stale native-span assertions, one formatting error, and four old five-second runtime timeouts. The assertions now check canonical records and activities. All 75 tests in the timeout files passed alone at unchanged budgets. The complete gate then passed with `NX_PARALLEL=1`.

Structural review extracted model-observation lifecycle and prompt-monitor ownership into cohesive private modules. Native field projection and missing-field reconciliation have separate helpers. Larger private orchestration functions and small test-helper duplication remain; no zero-debt claim is made. Telemetry projection remains S8 work. Production Plan cutover remains S9 work. The legacy hosted path does not forward model observation events before S10.

## Documentation impact

Classification: implementation-only

- PRD: no change
- RFC: no change
- SPEC: no contract change
- TASK: record native caller, observation, cleanup, and live-agent evidence.
- ADR required: no

### Rationale

The active target spec already assigns native resource ownership to Effect and preserves canonical observations. This slice replaces private integration code within that contract.

### Required work

Reconcile adapter READMEs and this task after verification. Preserve public and wire Zod contracts. Record unavailable live evidence separately from protocol-fixture results.

### Open questions

None.

## Delivery state

Completed on `feat/effect-v4-migration` in this task commit, after S4 commit `7def353`. Evidence is branch-local. No default-branch, remote-CI, or full migration delivery claim is made. OpenCode live model verification remains unavailable because its provider rejected authentication.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-nested-workflows-and-validation: prerequisite task](./2026-10-21-effect-v4-nested-workflows-and-validation.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
