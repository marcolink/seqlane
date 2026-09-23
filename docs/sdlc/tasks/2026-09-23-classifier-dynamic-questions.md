---
id: task.classifier-dynamic-questions
title: Validate Static Choice Score and Noul Questions
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

# Validate Static Choice Score and Noul Questions

## Objective

Complete static Choice, Score, and Noul question support and full answer
validation on the working Jev tracer path. Keep the task input dynamic through
the `state` callback while every question stays fixed in the task definition.

## Upstream requirements

Implement [spec.classifier-tasks, fixed question shape](../specs/2026-09-23-classifier-tasks.md#requirement-fixed-question-shape) and [full result](../specs/2026-09-23-classifier-tasks.md#requirement-full-result). Start after [task.classifier-system-one-tracer](./2026-09-23-classifier-system-one-tracer.md) proves the real path.

## Scope

- Extend the working Noul path to Choice and Score, including optional Noul
  true/false criteria.
- Validate every static question when the task is defined. Reject empty or
  invalid instructions, Choice option maps, Score levels, and Noul criteria.
- Serialize all declared questions with one input-derived state in one provider
  request. Preserve their fixed kinds and declaration order where possible.
- Parse full Jev answers and cross-check each answer against its static question:
  IDs and kinds, selected Choice key, probability domains and sums, Score legend
  and index range, and Noul range. Keep complete usage and model identity.
- Preserve dynamic state selection across repeat invocations and ordinary input
  bindings from prior task outputs.

## Out of scope

- Dynamic question IDs, kinds, instructions, or criteria; thresholds; Boolean
  or tri-state policy; item-list batching; Laya routing; structured instruction
  values; and model fallback.
- Transient retries and per-attempt observation detail belong to the next task.
  The tracer already provides the transport budget and one-attempt observation.

## Implementation plan

### Tracer bullet

- **Outcome:** one task sends static Choice, Score, and Noul questions over an
  input-derived state and returns correctly typed full answers for every ID.
- **Path:** validated task input → `state` → request schema → existing System
  One client → fixture response → paired answer validation → task output.
- **Risk:** a generic answer union cannot prove that a returned Choice key or
  Score legend matches the declared criteria.
- **Evidence:** one positive fixture run and negative runs for a foreign Choice
  key, missing probability, wrong Score legend, and changed question key. All
  negative cases fail before downstream tasks consume output.
- **Excluded:** retry policy and production endpoint.

1. Complete the static question and inferred result schemas in core. Keep casts
   only at narrow, documented interop edges. Never coerce an unknown response
   into a typed answer.
2. Extend paired response validation after the owning Zod schema parses the
   body.
3. Extend core, runtime, and workflow tests for all static question kinds and
   malformed cases. Use a second task's output as classifier input in one test.

## Affected areas

Core classifier contracts and factory with colocated specs; the runtime
classifier client with colocated specs; one focused workflow integration
fixture. Keep existing Plan validation and session policy unchanged.

## Verification

- Run test mapping, focused core/runtime tests, typecheck, lint, and build.
- Add compile-time checks for exact answer keys and kinds. Choice values stay
  `string` and receive runtime membership validation.
- Test 2–255 Choice options and 2–10 Score levels at boundaries, empty and
  duplicate criteria, NaN/infinite/out-of-range numbers, wrong answer kind,
  missing/extra answers, and probability sums outside tolerance.
- Assert invalid static questions fail at task definition and cause zero HTTP
  requests. Assert malformed provider answers cause no downstream invocation.

## Completion criteria

- All three static question kinds work together in one request.
- The result retains every documented field and matches the exact declared
  questions, not merely a generic answer union.
- Different task inputs can change state without changing questions.

## Outcome

Pending implementation.

## Delivery state

Planned. No implementation or target-branch delivery is claimed.

## Traceability

- [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md)
- [task.classifier-system-one-tracer](./2026-09-23-classifier-system-one-tracer.md)
