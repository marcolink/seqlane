---
id: task.classifier-dynamic-questions
title: Validate Dynamic Choice Score and Noul Questions
status: planned
owners:
  - core
created: 2026-09-23
updated: 2026-09-23
upstream:
  - spec.classifier-tasks
  - task.classifier-system-one-tracer
supersedes: []
---

# Validate Dynamic Choice Score and Noul Questions

## Objective

Complete dynamic question construction and full answer validation on the
working Jev tracer path. Keep question IDs and kinds fixed while every request
can change instructions, Choice options, and Score levels.

## Upstream requirements

Implement [spec.classifier-tasks, fixed question shape](../specs/2026-09-23-classifier-tasks.md#requirement-fixed-question-shape) and [full result](../specs/2026-09-23-classifier-tasks.md#requirement-full-result). Start after [task.classifier-system-one-tracer](./2026-09-23-classifier-system-one-tracer.md) proves the real path.

## Scope

- Extend the core discriminated schemas and generated output type/schema for
  Choice and Score, plus optional Noul true/false criteria.
- Validate one `build` result per invocation before HTTP. Reject changed,
  missing, or extra question IDs; invalid state; invalid instructions; invalid
  Choice option maps; and invalid or duplicate Score levels.
- Serialize all declared questions in one provider request. Preserve their
  fixed kinds and source order where the wire map permits it.
- Parse full Jev answers and cross-check each answer against its exact
  resolved question: IDs/kinds, selected Choice key, probability domains and
  sums, Score legend/index range, and Noul range. Keep complete usage/model.
- Preserve dynamic `build` behavior across repeat invocations and ordinary
  workflow input bindings from prior task outputs.

## Out of scope

- Thresholds, Boolean or tri-state policy, item-list batching, Laya routing,
  dynamic question IDs or kinds, structured object instructions, and model
  fallback.
- Transient retries and per-attempt observation detail belong to the next task.
  The tracer already provides the transport budget and one-attempt observation.

## Implementation plan

### Tracer bullet

- **Outcome:** two inputs to the same task yield different Choice options and
  Score levels while returning correctly typed full answers for the same IDs.
- **Path:** validated task input → `build` → request schema → existing System
  One client → fixture response → paired answer validation → task output.
- **Risk:** a static Zod output schema alone cannot prove that a returned
  Choice key or Score legend matches options built for this invocation.
- **Evidence:** a positive fixture run for both inputs and negative runs for
  a foreign Choice key, missing probability, wrong Score legend, and changed
  question key. All negative cases fail before downstream tasks consume output.
- **Excluded:** retry policy and production endpoint.

1. Implement the fixed `questionKinds` to `build` type mapping and generated
   output schema in core. Keep casts only at narrow, documented interop edges;
   never coerce an unknown response into a typed answer.
2. Add request validation before `fetch` and paired response validation after
   the owning Zod schema parses the body.
3. Extend core, runtime, and workflow tests with dynamic criteria and all
   malformed cases. Use a second task's output as classifier input in one test.

## Affected areas

Core classifier contracts/factory and colocated specs; the runtime classifier
client and its colocated specs; one focused workflow integration fixture.
Keep existing Plan validation and session policy unchanged.

## Verification

- Run test mapping, focused core/runtime tests, typecheck, lint, and build.
- Add compile-time checks for known answer keys and kinds; dynamic Choice
  values stay `string` and receive runtime membership validation.
- Test 2–255 Choice options and 2–10 Score levels at boundaries, empty and
  duplicate criteria, NaN/infinite/out-of-range numbers, wrong answer kind,
  missing/extra answers, and probability sums outside tolerance.
- Assert malformed builder output causes zero HTTP requests. Assert malformed
  provider answers cause no downstream task invocation.

## Completion criteria

- All three question kinds work together in one request.
- The result retains every documented field and matches the exact resolved
  request, not merely a generic answer union.
- Static and dynamic definitions use the same execution path.

## Outcome

Pending implementation.

## Delivery state

Planned. No implementation or target-branch delivery is claimed.

## Traceability

- [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md)
- [task.classifier-system-one-tracer](./2026-09-23-classifier-system-one-tracer.md)
