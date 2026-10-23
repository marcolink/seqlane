---
id: task.cancel-opencode-archive-verification
title: Cancel OpenCode archive verification
status: completed
owners:
  - core
created: 2026-10-23
updated: 2026-10-23
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-remaining-actions-and-distribution
supersedes: []
---

# Cancel OpenCode archive verification

## Objective

Fix approved finding `SEQ-PR180-002`: archive verification must receive cancellation and finish subprocess cleanup before temporary files are removed.

## Upstream requirements

The active execution specification requires scoped Action installation, finite deadlines and retained cleanup ownership. The setup README already promises interruptible executable checks.

## Documentation impact

Classification: implementation-only repair of the existing contract. PRD, RFC, ADR and SPEC need no change. This task records the approved fix. Clarify setup cleanup ordering in its README if needed. Finding `SEQ-PR180-006` describes the same cause, but only `002` is approved for handling and replies.

## Scope

Both extracted and installed executable checks in `installArchive`, signal propagation, subprocess settlement, cleanup ordering and regression tests.

## Out of scope

CI payload policy, PR splitting, unrelated review findings, dependency changes, resolver composition, registry publication and merge to next.

## Implementation plan

First reproduce cancellation during an extracted executable check with a real controlled child. Forward the Effect cancellation signal through both verification calls. Retain ownership until the verifier and actual subprocess close. Cover installed verification, finite failure paths and cleanup ordering. Reuse pinned APIs and existing installation lifetimes; keep SDK interop at the I/O edge.

## Affected areas

`actions/setup-opencode/src/archive.ts`, executable I/O, related tests and the setup README.

## Verification

Run test mapping before tests. Prove actual child exit before extraction and archive cleanup for cancellation at either verification stage. Preserve normal installation, cache, checksum, timeout, output bounds and bundle-loading behavior. Use controlled subprocesses without provider calls.

Run scoped tests, types, lint, fresh Action build and bundle checks. Then run the complete repository gate. Record hosted verification separately on the published head.

## Completion criteria

Both checks receive cancellation. The Action cannot settle or remove temporary verification files before its owned child exits. Tests demonstrate the regression and preserve existing success and failure behavior. One commit contains this approved fix.

## Outcome

Both archive verification calls now run under an owned cancellation scope. Release aborts the verifier and waits for its Promise to settle. The executable I/O adapter waits for the actual child `close` event, including after cancellation or failure, before returning. Temporary archive and extraction cleanup follows that release.

The old implementation reproduced cancellation returning while the installed verifier child was still alive. Real subprocess regressions now pass for both extracted and installed checks. A controlled delayed verifier proves that temporary files remain until verification settles. Existing timeout, checksum, cache and installation cases still pass.

Verification passed on Node 24.16.0: 625 test mappings, 56 setup Action tests, a fresh Action bundle and runtime-loading check, typecheck, lint, formatting and the complete root gate. The root gate includes frozen installation, 360 canonical documents, all project tests, build, Nx sync and diff checks. Final review removed four new test assertion warnings; focused archive and I/O tests and scoped lint pass without those warnings. No quality gate failure or suppression was introduced. README cleanup ordering matches the implementation. The active specification remains unchanged.

## Delivery state

Implemented and locally verified on `feat/effect-v4-migration` for [PR #180](https://github.com/marcolink/seqlane/pull/180), based on next. The containing task commit records the implementation. Published-head and hosted Action verification are tracked in the PR. No target-branch merge or publication is claimed.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md#requirement-action-lifetimes)
- [task.effect-v4-remaining-actions-and-distribution](./2026-10-21-effect-v4-remaining-actions-and-distribution.md)
- [PR #180 review report](https://github.com/marcolink/seqlane/pull/180#issuecomment-6374175581)
