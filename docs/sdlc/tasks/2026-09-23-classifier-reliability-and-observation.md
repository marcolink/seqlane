---
id: task.classifier-reliability-and-observation
title: Bound Classifier Retries and Retain Full Observations
status: planned
owners:
  - core
created: 2026-09-23
updated: 2026-09-23
upstream:
  - spec.classifier-tasks
  - task.classifier-dynamic-questions
supersedes: []
---

# Bound Classifier Retries and Retain Full Observations

## Objective

Give the dynamic Jev path a 20-second total deadline, at most three transient
retries, typed failures, cancellation, and full request/response inspection
without exposing credentials.

## Upstream requirements

Implement [spec.classifier-tasks, deadline and retries](../specs/2026-09-23-classifier-tasks.md#requirement-deadline-and-retries) and [complete observation](../specs/2026-09-23-classifier-tasks.md#requirement-complete-observation) after [task.classifier-dynamic-questions](./2026-09-23-classifier-dynamic-questions.md).

## Scope

- One 20-second wall-clock deadline across `build`, all HTTP attempts,
  response validation, and backoff. At most four attempts total. Respect the
  run's cancellation signal and stop retries immediately on cancellation.
- Retry network errors, 429, 529, and 5xx only. Honor `Retry-After` within
  the remaining budget. Never retry auth, validation, or malformed responses.
- Enforce 1 MiB UTF-8 request and response limits; no silent truncation.
- Reject unsafe endpoint URLs and redirects before a bearer token can leak.
- Emit the exact resolved state/questions and full validated response at the
  invocation's local observation boundary. Capture attempt count, timings,
  returned model, and usage as bounded metadata. Preserve the current split
  between full detail and narrow CLI/protocol progress.
- Test standalone no-persistence and direct/hosted tracing behavior separately.

## Out of scope

- Production telemetry exporter, new store, custom retention duration, model
  fallback, thresholding, or a live credential-dependent CI test.

## Implementation plan

### Tracer bullet

- **Outcome:** a fixture returns 429 once, then a valid full result; the task
  succeeds within its original deadline and records both attempts under one
  invocation.
- **Path:** Mastra task abort signal → classifier client deadline/backoff →
  local HTTP fixture → validated result → invocation observation.
- **Risk:** a retry can outlive cancellation or create a second task identity,
  while raw state/credential handling can leak through progress or errors.
- **Evidence:** fake-clock and integration assertions show two attempts under
  one invocation, exact request/response detail, no token in serialized
  observations, and no raw payload in CLI progress.
- **Excluded:** other retry categories until this path passes.

1. Add typed configuration, request, response, timeout, and cancellation errors
   with original causes at private package boundaries.
2. Start a monotonic deadline before the synchronous builder runs; pass its
   remaining budget into the fetch/retry loop. Check budget after building and
   validation, and abort fetch/backoff at expiry. Bound body reads and disable
   redirects. Keep abort listeners and timers scoped to the invocation and
   release them on every exit path.
   Use delays of 200, 400, and 800 ms for retries, each raised to a valid
   `Retry-After` minimum when present. Parse both delta-seconds and HTTP-date;
   invalid values use the normal delay. If a delay cannot fit the remaining
   budget, fail at the deadline without another request. Reuse the exact
   serialized body for every HTTP attempt.
3. Wire full request/result observation through the existing Mastra/protocol
   detail path. Do not create a second trace store or flatten raw JSON into
   OTel metric labels.
4. Add the remaining failure and cancellation tests after the first retry path
   passes; measure worst-case elapsed time with a fake clock.

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

- No HTTP attempt or retry continues beyond the 20-second invocation deadline;
  synchronous builder overrun fails before HTTP as soon as the builder returns.
- Cancellation wins over a concurrent response.
- Full permitted detail is inspectable; credentials and raw values stay out of
  progress/metrics labels.
- Every failure remains a failure, never a negative classification.

## Outcome

Pending implementation.

## Delivery state

Planned. No implementation or target-branch delivery is claimed.

## Traceability

- [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md)
- [task.classifier-dynamic-questions](./2026-09-23-classifier-dynamic-questions.md)
- [spec.otel-aligned-observation-contract](../specs/2026-09-19-otel-aligned-observation-contract.md)
