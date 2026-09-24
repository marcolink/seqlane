---
id: task.classifier-reliability-and-observation
title: Bound Classifier Retries and Retain Full Observations
status: completed
owners:
  - core
created: 2026-09-23
updated: 2026-09-24
upstream:
  - spec.classifier-tasks
  - task.classifier-dynamic-questions
supersedes: []
---

# Bound Classifier Retries and Retain Full Observations

## Objective

Add bounded transient retries and extend the single-attempt terminal
observation into per-attempt detail. Preserve the classifier transport budget,
one invocation identity, and credential isolation.

## Upstream requirements

Implement [spec.classifier-tasks, deadline and retries](../specs/2026-09-23-classifier-tasks.md#requirement-deadline-and-retries) and [complete observation](../specs/2026-09-23-classifier-tasks.md#requirement-complete-observation) after [task.classifier-dynamic-questions](./2026-09-23-classifier-dynamic-questions.md).

## Scope

- Extend the 20-second transport budget across HTTP attempts, response
  validation, and backoff. The budget starts after state selection, request
  validation, and serialization.
- Retry network errors, 429, 529, and 5xx only. Allow at most four attempts
  total. Honor Retry-After only within the remaining budget.
- Reuse the invocation abort signal. Stop fetch and backoff on cancellation or
  budget expiry; never retry auth, validation, or malformed responses.
- Keep the 1 MiB body caps and enforce the structural limits in the active
  classifier spec before recursive validation and observation.
- Extend the existing terminal invocation observation across retries with
  per-attempt request, response, timing, model, usage, and error detail. Reuse
  one observationId and the existing attemptIndex field.
- Confirm standalone runs retain no Seqlane-owned saved copy and direct/hosted
  runs use the existing tracing path.

## Out of scope

- Production telemetry exporter, new store, custom retention duration, model
  fallback, thresholding, or a live credential-dependent CI test.

## Implementation plan

### Tracer bullet

- **Outcome:** a fixture returns 429 once, then a valid full result; the task
  succeeds within its original transport budget and records both attempts under
  one invocation.
- **Path:** Mastra task abort signal → classifier client deadline/backoff →
  local HTTP fixture → validated result → existing invocation observation.
- **Risk:** a retry can outlive cancellation or create a second task identity,
  while raw state or credential handling can leak through progress or errors.
- **Evidence:** fake-clock and integration assertions show two attempts under
  one invocation, exact request/response detail, no token in serialized
  observations, and no raw payload in CLI progress.
- **Excluded:** other retry categories until this path passes.

1. Extend the tracer's typed failures for retry and backoff paths. Preserve
   original causes at private package boundaries.
2. Add retries inside the existing transport budget. Use delays of 200, 400,
   and 800 ms, raised to a valid Retry-After minimum when present. Parse
   delta-seconds and HTTP-date. If a delay cannot fit, stop without another
   request. Reuse the exact serialized body for each attempt.
3. Extend the existing single-attempt terminal observation for retry detail
   without adding a protocol event or trace store. Do not flatten raw JSON into
   metrics labels.
4. Add remaining failure and cancellation coverage after the retry path passes.
   Measure maximum elapsed transport time with a fake clock.

## Affected areas

Private runtime classifier client, runtime task execution context,
`libs/runtime/src/runtime/mastra/mastra-execution.ts` or its established
observation bridge, and colocated tests. Touch `libs/protocol` only if the
existing observation contract cannot carry the complete JSON detail; any
protocol change then requires round-trip and malformed-input compatibility
tests.

## Verification

- Run test mapping, scoped tests, typecheck, lint, build, and forbidden `/ee/`
  import check.
- Test 429/529/5xx/network retries; 400/401/403/404/422 and malformed output
  no-retry; `Retry-After` inside and beyond the budget; abort during fetch and
  backoff; deadline during response read; exact maximum of four attempts.
- Test oversized request/response, redirect rejection, no bearer token in
  errors/traces/events, and full state/questions/result preservation in local
  detail. Verify standalone creates no saved Seqlane artifact.
- Record the measured maximum elapsed time and test results in Outcome.

## Completion criteria

- No HTTP attempt or retry continues past the 20-second transport budget.
- Cancellation wins over a concurrent provider response.
- Full permitted detail is inspectable; credentials and raw values stay out of
  progress and metrics labels.
- Every failure remains a failure, never a negative classification.

## Outcome

The private client now retries network failures and HTTP 429, 529, and 5xx
responses up to four attempts within one 20-second transport budget. It reuses
the serialized request and observation ID, honors a valid `Retry-After` only
when its delay fits the remaining budget, and emits one indexed terminal
observation for each attempt. Cancellation and the deadline stop both requests
and backoff. Authentication, malformed responses, other HTTP failures, and
observation-sink failures do not trigger retries. The existing observation
path remains in use; no protocol event or store was added.

Fake-clock coverage reaches the 20,000 ms deadline during backoff, response
reading, and an in-flight request. The retry cap test observes exactly four
attempts; a local HTTP fixture and the workflow integration test prove a
429-then-success path retains one invocation identity.

Verification: 47 focused classifier/workflow tests pass; all 50 runtime test
files pass (422 tests); test mapping passes (318 mappings); `pnpm run typecheck`,
`pnpm build` (23 projects), runtime lint, formatting, SDLC validation (367
documents), and `git diff --check` pass. The repository-wide `pnpm test`
reaches project tests but exits on six unrelated `action-service-lifecycle`
failures because the sandbox rejects spawning `ps` with `EPERM`. Ripwire
reports short-horizon churn on the recently extended classifier client; no
complexity regression remains.

## Delivery state

Implemented and locally verified on branch
`codex/classifier-reliability-and-observation`, based on `main` at `1e3b915`.
Delivered to `main` in commit `ae11ebf` (PR #165).

## Traceability

- [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md)
- [task.classifier-dynamic-questions](./2026-09-23-classifier-dynamic-questions.md)
- [spec.otel-aligned-observation-contract](../specs/2026-09-19-otel-aligned-observation-contract.md)
