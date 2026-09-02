# ADR-015 — Add Semantic Validation Gates to Seqlane

**Status:** Accepted
**Scope:** Public workflow authoring, Plan IR, and runtime execution
**Related:** ADR-001, ADR-003, ADR-005, ADR-008, ADR-012

## Context

Seqlane already validates task input and output against their declared
schemas. That validation proves structure and type. It does not prove that a
result is correct, complete, safe, or ready for the next workflow stage.

Authors can model a validator as an ordinary task, but ordinary dataflow does
not enforce the validator's result. A downstream task can consume the result
without any Seqlane-owned rule that requires semantic success. A boolean
repeat condition provides bounded control flow, but it does not provide a
common result contract, evidence, or lifecycle representation for validation.

The gap applies to deterministic policies and to evaluator tasks that use a
prompt or another external judgement mechanism. It also applies to a repeat's
final result and to a repeat postcondition.

The design must preserve these existing constraints:

- Seqlane core and serialized Plans remain independent of Mastra and concrete
  executors.
- Runs remain autonomous and non-interactive under ADR-005.
- V1 has no implicit automatic retry under ADR-005.
- A Plan remains serializable and dependencies remain explicit `ValueRef`
  references.

## Decision

Seqlane will provide a first-class semantic validation gate. The gate will be
represented by a Seqlane-owned Plan node and will be available through the
workflow authoring APIs.

The gate accepts a typed value and one of two validator sources:

- a mechanical validator defined by Seqlane core; or
- a task-backed evaluator whose task returns a structured validation result.

The evaluator task may use a prompt, an agent, or another runtime capability.
That mechanism is an implementation detail of the evaluator task. The Plan
contains only its Seqlane-owned task identity and bindings.

Both sources produce the same `ValidationResult` contract. A successful result
allows dependent work to execute. A failed result fails the validation
invocation and prevents its dependents from executing. The default and only
V1 failure policy is fail-closed run failure. Retry, recovery routing, and
human approval require later decisions and must not be added implicitly.

Validation preserves the candidate value as its output and exposes the
structured validation result for evidence and repeat conditions. Validation
results are observable through the normal invocation lifecycle with a distinct
validation invocation kind.

Seqlane will provide a repeat postcondition helper. It validates the result
of each repeat body iteration, stops on success, and starts the next bounded
iteration on failure. Exhaustion remains a loop-limit failure and includes the
latest validation evidence. A repeat result can also be passed through a
normal validation gate after the repeat.

Validation is a gate, not a replacement for schema validation. Schema parsing
remains mandatory at task and workflow boundaries. Mechanical safety and
structural checks remain authoritative even when a task-backed evaluator is
used.

## Options Considered

### Use ordinary validator tasks only

Authors can create a task that returns `boolean` or a validation object. This
reuses the existing executor path, but Seqlane cannot enforce that the result
controls downstream execution. Every author must wire the gate correctly, and
validation has no common lifecycle or error contract. Rejected.

### Embed predicates in task definitions or Plan nodes

This makes simple checks concise, but executable callbacks cannot be serialized
in a Plan. It also makes prompt-backed evaluation and evidence inconsistent
with mechanical checks. Rejected.

### Add a first-class validation gate

This makes the continuation rule part of the Plan semantics while allowing
mechanical and task-backed implementations behind one contract. It adds a Plan
node, registry, runtime path, and event kind, but gives authors enforced
fail-closed behavior, repeat integration, and consistent evidence. Chosen.

### Add a general branch or approval system first

This could model recovery and human review, but it expands the control-flow
model beyond the immediate semantic-validation gap and conflicts with the
autonomous V1 runtime. Deferred.

## Consequences

### Positive

- Downstream work cannot start after a failed validation gate.
- Mechanical checks and prompt-backed evaluators share one typed result shape.
- Validation evidence is available to output projections and diagnostics.
- Repeat workflows can converge on a semantic postcondition with a bound.
- Plans remain serializable and executor-neutral.
- Validation remains composable with existing task and Flow DSL handles.

### Negative

- Core gains a validator contract and a new Plan node kind.
- Runtime and runner event schemas must represent validation invocations and
  validation failures.
- Task-backed evaluation adds executor cost and nondeterminism.
- Repeat postconditions require explicit evidence retention and loop-limit
  reporting.
- Retry, recovery, and approval semantics remain unavailable until separately
  designed.

## Constraints

- `seqlane-core` must not import Mastra or executor types.
- Serialized Plans must contain validator identity, bindings, and policy only;
  they must not contain callbacks, prompts resolved to executor objects, or
  model/client instances.
- A validation result must be structurally validated before it controls
  execution.
- A failed gate must emit a validation failure and prevent dependent nodes.
- V1 validation failure must not trigger an implicit retry.
- Repeat postconditions must use the existing finite iteration bound.
- Validators must be read-only with respect to Seqlane execution state.
- Evidence crossing runner or Studio boundaries must use existing display
  redaction and size limits.
- Human approval is outside this ADR and remains prohibited by ADR-005.

## Required Follow-up

TS-015 defines the public contracts, Plan representation, authoring helpers,
runtime lowering, repeat behavior, event/error schemas, registry plumbing,
tests, and migration boundaries.

## Revisit Conditions

Revisit this ADR if validation must route to recovery branches, request human
approval, retry a producer with feedback, or persist/replay nondeterministic
evaluator decisions. Each change must preserve the distinction between
structural schema validation and semantic acceptance.
