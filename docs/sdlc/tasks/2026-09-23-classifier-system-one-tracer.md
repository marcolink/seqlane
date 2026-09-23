---
id: task.classifier-system-one-tracer
title: Run One Classifier Task Through Jev
status: completed
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

Prove one classifier-only workflow from `defineClassifierTask` through
`seqlane run`, the Mastra step, the private System One HTTP client, and a full
validated Noul result. Emit the exact one-attempt request/response through the
existing typed observation path. Keep this tracer as the foundation for later
question kinds and retries.

## Upstream requirements

Implement the first vertical slice of [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md#requirements), including the fixed question declaration, one state, runtime connection, and full result. Do not redefine product behavior here.

## Scope

- @seqlane/core factory with id, Zod input, fixed questionKinds, and
  build(parsedInput). Exercise one Noul question; define provider-neutral
  discriminated contracts for all three kinds.
- Generated output schema and ordinary TaskDefinition execute callback. The
  output preserves model, answers, usage, and bounded opaque extensions; it
  does not threshold.
- Seqlane-owned classifier request/result types and `TaskContext.classify`. No
  Mastra, HTTP, or provider wire type enters core.
- Private client using native fetch, one POST to the configured System One
  endpoint, optional bearer header, bounded structural JSON, provider-to-core
  mapping, and typed failures. Use a local HTTP fixture.
- One per-run classifier connection independent of agent adapters. Add the
  private direct `startWorkflowRun` binding and standalone URL/model flags.
  Pass URL/model through internal child environment values and read
  `SEQLANE_CLASSIFIER_API_KEY` in the child. Strip all three values before
  workflow import. Keep public runner IPC unchanged.
- Classifier-only local execution without `--adapter`; cancellation and the
  post-build 20-second transport budget.
- Emit exact request and validated response through the existing
  `ExecutionObservationSink` and `invocation.observation` event. Never include
  credentials in the event.
- Update the public task and `seqlane run` reference pages for the supported
  Noul task and connection flags. Add a standalone Noul workflow example and a
  dedicated classifier authoring page. Leave the integrated Git diff example
  and full multi-kind guide to the later documentation task.

## Out of scope

- Dynamic Choice/Score behavior and paired answer validation, transient retries,
  per-attempt observation lifecycle, the integrated Git diff example and
  expanded multi-kind guide, and Laya certification.
- A config file, classifier profile registry, new Plan node, or agent session.

## Implementation plan

### Tracer bullet

- Outcome: a CLI workflow with one static Noul question returns a validated
  provider-neutral result and emits one invocation observation, without an
  agent adapter.
- Path: core factory → ordinary task Plan and Mastra step → local TaskContext
  capability → private System One client → existing observation sink/protocol
  event → CLI workflow result.
- Risk: classifier-only work may hit agent preflight, leak child environment
  into imported workflow code, or bypass the established observation identity.
- Evidence: CLI fixture test receives Noul probability 0.63, model and usage;
  observes exact request/response with no token; and asserts zero adapter
  creation. `--dry` emits a Plan without build or HTTP.
- Excluded: retries and dynamic Choice/Score execution.

1. Add provider-neutral core schemas/types, fixed question declarations, and
   the generated output schema. Do not add a task discriminator or inspect
   execute callbacks to predict classifier use.
2. Add one private `SystemOneClient` and `TaskContext.classify` through the
   existing executeTask path. Build the request, validate and serialize it
   within the structural limits, then start the 20-second transport budget in
   the client. Pass the task abort signal through the existing capability.
3. Map System One fields into Seqlane results and opaque extensions. Capture
   the per-run connection in trusted direct/runner composition. Pass CLI URL
   and model over internal child environment values; capture then remove them
   and the API key before workflow loading.
4. Emit a one-attempt model observation through `ExecutionObservationSink` and
   the existing `invocation.observation` event. Preserve Work/Run/Invocation
   identity, exact request/response JSON, model, usage, and timing; omit all
   authentication data.
5. Write the end-to-end fixture test before adding more question kinds. Fix any
   broken boundary exposed by the path, then proceed to the next task.

Use this first Noul fixture exchange. Keep the private provider mapping
and the public Seqlane result distinct.

Request:

```json
{"model":"jev-latest","state":"example diff","questions":{"needsReview":{"type":"noul","instructions":"Does this diff need review?"}}}
```

Response:

```json
{"model":"jev-1.13.0","answers":{"needsReview":{"type":"noul","noul":0.63}},"usage":{"input_tokens":10,"output_tokens":2}}
```

## Affected areas

`libs/core/src/contracts.ts`, `libs/core/src/dsl.ts`, core package exports,
`apps/docs/authoring-workflows/tasks-and-data-flow.md`,
`apps/docs/authoring-workflows/classifier-tasks.md`, `apps/docs/cli/run.md`,
`apps/docs/.vitepress/config.ts`, `workflows/classifier-example/`,
`libs/runtime/src/runtime/local/task-execution.ts`,
`libs/runtime/src/runner/profile/runtime-profile.ts`,
`libs/runtime/src/runner/profile/standalone-profile.ts`,
`libs/runtime/src/start-workflow-run.ts`, `apps/cli/src/commands/run.ts`,
`apps/cli/src/runner.ts`, and focused colocated tests. Place the private HTTP
client in a cohesive runtime classifier directory rather than an agent adapter.

## Verification

- Run the test-mapping check before focused tests.
- Core type tests prove parsed Input reaches build, fixed Noul answer type,
  generated output schema, and rejection of caller execute/output.
- Fixture tests prove exact provider request/header, neutral full result and
  extensions, invalid JSON failure, cancellation, structural limits, unsafe
  URL and redirect rejection, one `invocation.observation` event, and no token
  in errors/events.
- CLI/direct tests prove classifier-only local execution, a typed missing
  connection error on the first classifier request, unchanged Plan and IPC,
  `--dry`, URL/model capture and credential removal before workflow import, and
  no agent adapter creation.
- Run affected typecheck, build, lint, public-boundary checks, and forbidden
  /ee/ import check. Record commands and results in Outcome.

## Completion criteria

- The tracer path passes through the real task and runner boundaries.
- The full Noul result is provider-neutral, schema-validated, and preserved in
  meaning, including bounded opaque extensions.
- The request and response appear on the existing observation path with
  invocation identity and no credential data.
- No agent session, new Plan node, credential leak, or Seqlane config file is
  required.
- The standalone Noul example loads through the CLI, and the public docs show
  how to author and connect a classifier-only workflow.
- The next task can add Choice and Score without replacing this path.

## Outcome

Implementation and focused verification are complete on the delivery branch.
The branch also contains a standalone Noul example and dedicated classifier
authoring page, added during delivery at user request. The private System One
path supports Noul questions; dynamic Choice/Score and retries remain with
their later tasks. Target-branch delivery is pending.

PR preparation passed `pnpm typecheck`, `pnpm lint` (no errors), `pnpm build`,
`pnpm docs:index`, `pnpm docs:validate` (367 documents), public docs build,
Prettier, and `git diff --check` with Node 24. The standalone example also
returned a Noul result from the live TypeSafe endpoint in a user-run smoke test.

## Delivery state

Implementation is complete on `codex/classifier-system-one-tracer`, based on
PR #160 head `d9fcb37e9ed2e109ed38a7524d0ebbfad6395f93`. Target-branch delivery
is not claimed.

## Traceability

- [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md)
- [adr.classifier-task-runtime-boundary](../adrs/2026-09-23-classifier-task-runtime-boundary.md)
- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
