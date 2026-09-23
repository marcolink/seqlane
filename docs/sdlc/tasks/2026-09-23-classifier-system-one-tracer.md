---
id: task.classifier-system-one-tracer
title: Run One Classifier Task Through Jev
status: planned
owners:
  - core
created: 2026-09-23
updated: 2026-09-23
upstream:
  - spec.classifier-tasks
supersedes: []
---

# Run One Classifier Task Through Jev

## Objective

Prove one real classifier-only workflow from `defineClassifierTask` through
`seqlane run`, the Mastra step, the private System One HTTP client, and a full
validated Noul result. Keep this tracer code as the foundation for later kinds.

## Upstream requirements

Implement the first vertical slice of [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md#requirements), including the fixed question declaration, one state, runtime connection, and full result. Do not redefine product behavior here.

## Scope

- `@seqlane/core` factory with `id`, Zod `input`, fixed `questionKinds`, and
  `build(parsedInput)`. For this tracer, exercise one Noul question; design the
  discriminated contracts for all three kinds so the next task extends them.
- Generated output schema and a `TaskDefinition` with an `execute` callback.
  The output contains `model`, `answers`, and `usage`; it does not threshold.
- Seqlane-owned classifier request/result types and a `TaskContext.classify`
  capability. No Mastra, HTTP, or provider SDK type may enter core.
- Private client using native `fetch`, one POST to the configured System One
  endpoint, bearer header when configured, Zod-parsed response, and typed
  failures. Use a local HTTP fixture; no live API key is required for CI.
- One per-run classifier connection supplied independently of agent adapters.
  Add the private direct `startWorkflowRun` binding and standalone CLI flags
  `--classifier-url` / `--classifier-model`, plus runner environment key
  `SEQLANE_CLASSIFIER_API_KEY`. Keep the public runner IPC command unchanged.
- Classifier-only `local` execution without `--adapter`; abort propagation
  through the Mastra step and client.

## Out of scope

- Choice and Score completion, dynamic option/rubric validation, retries,
  detailed observations, the public example, and Laya certification.
- A config file, classifier profile registry, new Plan node, or agent session.

## Implementation plan

### Tracer bullet

- **Outcome:** a CLI workflow with one static Noul question returns Jev's full
  `{ model, answers, usage }` result and consumes no coding-agent adapter.
- **Path:** `libs/core/src/contracts.ts` and `dsl.ts` → workflow binding and
  unchanged task Plan node → `apps/cli/src/commands/run.ts` and `runner.ts` →
  `libs/runtime/src/start-workflow-run.ts` / runner profile resolution →
  `libs/runtime/src/runtime/local/task-execution.ts` → private HTTP client →
  local System One fixture → workflow output.
- **Risk:** classifier-only work may accidentally follow agent-session
  preflight or omit the connection in the `local` runtime profile.
- **Evidence:** a focused CLI integration test receives `0.63` as a Noul
  probability with returned model and usage, and asserts zero agent adapter
  creation. `--dry` emits a Plan with no HTTP call or credential requirement.
- **Excluded:** dynamic Choice/Score, retries, tracing, and real Jev traffic.

1. Add core schemas/types and the factory. Do not add a task discriminator or
   inspect `execute` callbacks to predict classifier use.
2. Add one private `SystemOneClient` and the `TaskContext.classify` bridge. Use
   the existing `executeTask` path rather than a new executor scheduler. The
   generated callback starts the invocation budget, builds and validates the
   request, then calls `context.classify(request, { signal, timeoutMs })`.
   Keep model, endpoint, and token out of that request; the runtime client adds
   the selected model when it serializes the provider body.
3. Extend trusted direct-run and CLI-owned worker composition. Parse URL/model
   with Zod and read the token from the environment. Never pass the token in
   the public `RunRequest` payload or include it in errors/observations.
4. Write the end-to-end fixture test before adding more question kinds. Fix any
   broken boundary exposed by that path, then proceed to the next task.

Use this first fixture exchange. It also fixes the field spelling for the
client and full Noul result:

```json
{"model":"jev-latest","state":"example diff","questions":{"needsReview":{"type":"noul","instructions":"Does this diff need review?"}}}
```

```json
{"model":"jev-1.13.0","answers":{"needsReview":{"type":"noul","noul":0.63}},"usage":{"input_tokens":10,"output_tokens":2}}
```

## Affected areas

`libs/core/src/contracts.ts`, `libs/core/src/dsl.ts`, core package exports,
`libs/runtime/src/runtime/local/task-execution.ts`,
`libs/runtime/src/runner/profile/runtime-profile.ts`,
`libs/runtime/src/runner/profile/standalone-profile.ts`,
`libs/runtime/src/start-workflow-run.ts`, `apps/cli/src/commands/run.ts`,
`apps/cli/src/runner.ts`, and focused colocated tests. Place the private HTTP
client in a cohesive runtime classifier directory rather than an agent adapter.

## Verification

- Run the test-mapping check before focused tests.
- Core type tests prove parsed `Input` reaches `build`, fixed Noul answer type,
  generated `output` schema, and rejection of caller `execute`/`output`.
- Fixture tests prove exact request JSON/header, full response, invalid JSON
  failure, cancellation, and no token in serialized errors.
- CLI/direct tests prove classifier-only local execution, a typed missing
  connection error on the first classifier request, unchanged Plan and IPC,
  `--dry`, and no agent adapter creation.
- Run affected typecheck, build, lint, public-boundary checks, and forbidden
  `/ee/` import check. Record commands and results in Outcome.

## Completion criteria

- The tracer path passes through the real task and runner boundaries.
- Full Noul result is returned unchanged in meaning and validated with Zod.
- No agent session, new Plan node, credential leak, or Seqlane config file is
  required.
- The next task can add Choice and Score without replacing this path.

## Outcome

Pending implementation.

## Delivery state

Planned. No implementation or target-branch delivery is claimed.

## Traceability

- [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md)
- [adr.classifier-task-runtime-boundary](../adrs/2026-09-23-classifier-task-runtime-boundary.md)
- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
