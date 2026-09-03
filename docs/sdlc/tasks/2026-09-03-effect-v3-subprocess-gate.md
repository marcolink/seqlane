---
id: task.effect-v3-subprocess-gate
title: Prove the Private Effect Subprocess Contract
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.local-mechanical-tasks
supersedes: []
---

# Prove the Private Effect Subprocess Contract

## Objective

As a Seqlane maintainer, I can decide if the private Effect platform can own
local process lifecycle before Seqlane exposes local tasks.

## Upstream requirements

- The subprocess feasibility gate in
  [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md).

## Scope

- Run the dependency security preflight for the matching Effect platform.
- Add only the private platform dependencies required for the prototype.
- Build a private, focused subprocess prototype.
- Prove the seven feasibility requirements with automated tests.
- Record a pass or stop decision in the completion outcome.

## Out of scope

- Public task contracts, Plan changes, and runtime task dispatch.
- Shell execution, `node:child_process`, and a runtime-engine migration.

## Implementation plan

1. Validate the private platform dependency choice.
2. Implement the focused subprocess prototype and typed failures.
3. Prove argv execution, bounded streams, cancellation, and termination order.

## Affected areas

- `libs/seqlane-runtime/src/runtime/local/`
- `pnpm-lock.yaml`

## Verification

```text
pnpm run test:mapping
pnpm exec nx run seqlane-runtime:test -- --run src/runtime/local/effect-subprocess-prototype.spec.ts
pnpm exec nx run seqlane-runtime:typecheck
pnpm exec nx run seqlane-runtime:lint
pnpm exec prettier --check eslint.config.mjs libs/seqlane-runtime/src/runtime/local/effect-subprocess-prototype.ts libs/seqlane-runtime/src/runtime/local/effect-subprocess-prototype.spec.ts
git diff --check
```

## Completion criteria

The prototype proves direct argv use without a shell, workspace `cwd`,
separate bounded stdout and stderr capture, exit-code completion after both
streams close, AbortSignal cancellation, termination before scope completion,
and typed spawn, stream, exit-wait, and interruption failures.

## Outcome

The gate passed with the installed Effect platform dependencies. The prototype
and its focused tests prove the required lifecycle behavior. Dependency
security preflight passed, and the implementation continued to the public
contract and runtime stories in [PR #8](https://github.com/marcolink/seqlane/pull/8).

## Traceability

- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [adr.local-mechanical-tasks](../adrs/2026-09-03-local-mechanical-tasks.md)
- [PR #8](https://github.com/marcolink/seqlane/pull/8)
