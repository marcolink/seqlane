---
id: task.classifier-dynamic-questions
title: Validate Static Choice Score and Noul Questions
status: completed
owners:
  - core
created: 2026-09-23
updated: 2026-09-24
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

- **Outcome:** one workflow sends static Choice, Score, and Noul questions over
  an input-derived state and returns complete, question-validated answers.
- **Path:** validated task input → `state` → request schema → System One client
  → provider response mapper → paired Core result validation → success
  observation → task output.
- **Risk:** generic answer validation can accept a Choice key or Score legend
  that does not match the declared criteria. Validation after the success
  observation would also report malformed provider data as a successful call.
- **Evidence:** one mixed positive fixture run and negative runs for a foreign
  Choice key, mismatched probability keys, wrong Score legend or range, and
  changed question ID or kind. Invalid responses become typed response
  failures, emit no success observation, and do not invoke downstream tasks.
- **Excluded:** retry policy and production endpoint.

1. Reuse the existing static question schemas and inferred answer kinds in
   core. Extend `createClassifierResultSchema` to validate each answer against
   its declared question: Choice selection and exact probability keys, Score
   range, zero-based legend and exact probability keys, and Noul range. Keep
   the shared finite-number and probability-sum checks.
2. Add private Jev Choice and Score response schemas and mappings. Before the
   client emits a success observation, validate the mapped result with the
   question-aware Core schema. Translate validation failures to a typed
   classifier response error so the existing failed-observation path handles
   them. Keep provider wire fields private and never coerce unknown data into
   an answer.
3. Extend core, runtime, and workflow coverage for the mixed response and
   malformed cases. Use a second task's output as classifier input and verify
   that repeated invocations can select different state with fixed questions.

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

Core now validates each answer against its declared Choice, Score, or Noul
question. The Jev runtime maps all three kinds and validates the paired result
before emitting a success observation. Mixed workflow coverage confirms that
invalid provider answers fail before downstream tasks run, while each task
invocation can select new state with fixed questions.

Focused classifier and workflow specs pass (41 tests). Test mapping, full
typecheck, workspace build, and workspace lint also pass. Lint reports existing
warnings in unrelated files.

## Delivery state

Delivered to `main` in commit `1e3b915` (PR #164).

## Traceability

- [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md)
- [task.classifier-system-one-tracer](./2026-09-23-classifier-system-one-tracer.md)
