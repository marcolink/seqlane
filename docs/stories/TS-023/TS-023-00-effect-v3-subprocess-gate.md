# TS-023-00 — Prove the Effect v3 Subprocess Contract

**Status:** completed

## User outcome

As a Seqlane maintainer, I can decide if the installed Effect v3 platform can
own local process lifecycle before Seqlane exposes local tasks.

## Scope

- Run the Snyk preflight for matching Effect platform dependencies.
- Add only the private Effect platform dependencies required for the prototype.
- Build a private, focused Effect v3 subprocess prototype.
- Prove the seven TS-023 feasibility requirements with automated tests.
- Record a pass or stop decision in the story completion evidence.

## Out of scope

- Public task contracts, Plan changes, and runtime task dispatch.
- `node:child_process`, `execa`, and an Effect v4 migration.

## Acceptance criteria

**Scenario:** *Effect v3 supports a controlled foreground process*

- **Given:** the matching Effect v3 platform Node dependencies pass security review
- **When:** the prototype starts a command with argv and a workspace directory
- **Then:** it collects bounded output, returns the exit code, and waits for termination

**Scenario:** *Effect v3 supports invocation cancellation*

- **Given:** a long-running child process
- **When:** the prototype receives an abort signal
- **Then:** the process terminates before the prototype completes

**Scenario:** *Effect v3 cannot meet the contract*

- **Given:** any feasibility requirement cannot be met with Effect v3
- **When:** the prototype evaluation completes
- **Then:** TS-023 stops and an Effect v4 migration becomes the required next delivery

## Source

- [ADR-023](../../ADR-023-local-mechanical-tasks.md)
- [TS-023](../../TS-023-local-mechanical-tasks.md)

## Completion Evidence

The Effect v3 gate passed with `effect@3.22.1`, `@effect/platform@0.97.1`, and
`@effect/platform-node@0.108.1`. The security preflight found the two added
platform packages directly non-vulnerable in Snyk.

`effect-subprocess-prototype.spec.ts` proves direct executable and argv use
without a shell, workspace `cwd`, separate bounded stdout and stderr capture,
exit-code completion after both streams close, and AbortSignal cancellation.
The cancellation proof confirms that the child no longer exists when the scoped
prototype completes. Spawn errors, bounded-stream errors, exit-wait errors, and
interruption each have dedicated private error types. The Node Effect executor
returns an exit code, including non-zero codes, rather than a typed exit error;
the prototype maps the documented `Process.exitCode` platform-error channel
when it occurs.

Verification passed:

```text
pnpm run test:mapping
pnpm exec nx run seqlane-runtime:test -- --run src/runtime/local/effect-subprocess-prototype.spec.ts
pnpm exec nx run seqlane-runtime:typecheck
pnpm exec nx run seqlane-runtime:lint
pnpm exec prettier --check eslint.config.mjs libs/seqlane-runtime/src/runtime/local/effect-subprocess-prototype.ts libs/seqlane-runtime/src/runtime/local/effect-subprocess-prototype.spec.ts docs/stories/TS-023/TS-023-00-effect-v3-subprocess-gate.md
git diff --check
```
