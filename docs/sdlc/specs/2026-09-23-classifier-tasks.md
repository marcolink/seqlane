---
id: spec.classifier-tasks
title: Dynamic Classifier Task Contract
status: active
owners:
  - core
created: 2026-09-23
updated: 2026-09-23
upstream:
  - prd.seqlane-on-mastra
  - rfc.mastra-runtime-and-operational-foundation
  - adr.classifier-task-runtime-boundary
supersedes: []
---

# Dynamic Classifier Task Contract

## Summary

Add `defineClassifierTask` for one state and many fixed-kind questions whose
wording and criteria can change per task invocation. Return the full System One
result. The first private transport is Jev HTTP. A standalone run supplies one
connection without an agent adapter or configuration file.

## Goals

- Preserve the existing `createFlow().task()` binding, Plan, Mastra step,
  validation, cancellation, and workflow-output paths.
- Support Choice, Score, and Noul in one request with parsed dynamic input.
- Expose full, validated probabilities to later tasks.
- Resolve URL, model, and token once per run, outside authored workflow code.
- Prove a real path in `git-diff-summary-example` before wider use.

## Non-goals

- Thresholds, Boolean coercion, abstention policy, model fallback, or agent
  sessions for classifier questions.
- Per-task classifier profiles, multiple states in one invocation, item-list
  concurrency helpers, or Laya certification in the first delivery.
- Structured object/array instructions or criteria, streaming, embeddings,
  arbitrary free-text generation, or classifier fine-tuning.
- A new Plan node, scheduler, persistence store, or required config file.

## Terminology

- **Question kind:** fixed `choice`, `score`, or `noul` for a named question.
- **Resolved request:** the state and question payload produced by `build` for
  one validated task input.
- **Classifier connection:** the private endpoint, model ID, and bearer token
  available to one run.
- **Attempt:** one HTTP POST. Up to three retries allow four attempts total.

## Requirements

### requirement-fixed-question-shape

The author declares a nonempty map of stable question IDs to kinds. `build`
must return exactly those IDs. It may change each question's instructions,
Choice options, and Score levels using validated task input. It cannot change
an ID or kind. A task with constant `build` output is a static classifier.
All questions share one state and go in one provider request. Question answers
do not become input to other questions in that request.

### requirement-full-result

The task returns the complete validated System One response without applying a
threshold or stripping additional provider fields. It preserves `model`,
`answers`, `usage`, Choice distributions and
confidence, Score value/legend/distribution/confidence, and Noul probability.
Missing, extra, or mismatched answer IDs fail. Probability values are not
converted to booleans. Any workflow decision derived from them belongs in an
ordinary downstream task.

### requirement-runtime-connection

One connection is selected for a run. A classifier task does not require
`--adapter`, a coding-agent model, a session, or a workspace read. A workflow
that also has agent tasks can use `--adapter` independently. Connection and
credential values never enter task definitions, Plans, runner IPC commands,
workflow outputs, or progress events. The model returned by Jev remains in
the classifier task result.

### requirement-deadline-and-retries

Each classifier invocation has one 20-second wall-clock deadline covering
request construction, HTTP attempts, response reading/validation, and backoff.
Start a monotonic deadline immediately before the synchronous `build` call.
Check the remaining budget after `build` and each synchronous validation step;
never start HTTP or another retry when it has expired. Abort in-flight fetch
and backoff at the deadline. A synchronous builder cannot be preempted, so a
builder that runs past the deadline fails as soon as it returns.
The first attempt may be followed by at most three retries on network failure,
HTTP 429, 529, or 5xx. Retry only the same endpoint and model. Respect
`Retry-After` only when it fits the remaining deadline. Do not retry 400,
401, 403, 404, 422, malformed output, or caller cancellation. The first
attempt and every retry share the invocation's abort signal.

### requirement-complete-observation

Retain the exact resolved state, questions, and validated response at the
invocation's local observation boundary, with task/invocation identity and
model/usage. Never include the bearer token or authentication header. Follow
the existing consumer rule: CLI progress and runner summaries remain bounded
and do not expose raw task values. Hosted tracing may persist the observation
through Mastra; standalone runs create no Seqlane history or artifact store.
If a request exceeds the supported size, fail before sending; never truncate
the state or questions silently.

## Detailed design or contracts

### Public authoring shape

`@seqlane/core` exports `defineClassifierTask` and the corresponding inferred
question/result types. This is illustrative TypeScript; implementation may
split the types into cohesive files without changing the behavior.

```ts
const classify = defineClassifierTask({
  id: "git-diff-classifier",
  input: classifierInputSchema,
  questionKinds: {
    area: "choice",
    priority: "score",
    needsSecurityReview: "noul",
  },
  build: ({ diff, candidateAreas, priorityLevels }) => ({
    state: { diff },
    questions: {
      area: {
        instructions: "Which area deserves the first review?",
        criteria: Object.fromEntries(
          candidateAreas.map((area) => [area.id, area.description]),
        ),
      },
      priority: {
        instructions: "How urgent is review of this change?",
        criteria: priorityLevels,
      },
      needsSecurityReview: {
        instructions: "Does this change need security review?",
      },
    },
  }),
});

const workflow = createFlow({
  id: "classify-diff",
  input: classifierInputSchema,
  output: classify.output,
})
  .task("classify", classify, ({ input }) => input)
  .output(({ tasks }) => tasks.classify.output)
  .define();
```

`questionKinds` is an authoring declaration, not a provider/model selector.
The factory generates a Zod output schema compatible with `TaskDefinition`.
TypeScript maps each fixed ID to its answer kind; a Choice selected from
runtime-built options has type `string` and is checked against that invocation's
resolved option keys. `build` receives only `z.output<inputSchema>` after
binding resolution and input parsing. It runs once per task invocation,
including each workflow-level repeat; HTTP retries reuse its resolved request.
It receives no token or provider client. The factory
rejects caller-supplied `execute` and `output` fields to prevent divergence.

`createFlow().task()` runs its binding against workflow references when it
builds the Plan. It does not call `build`; the runtime calls `build` after
resolving and validating the task's concrete input. A classifier definition is
kept in the in-memory registry. The Plan node remains `type: "task"` with its
existing task ID, input binding, dependencies, and policies. A classifier
call does not use an agent session. Authors omit `session` for classifier
tasks. Existing `createFlow().task()` session policy remains unchanged; do not
add classifier-specific Plan inspection or task discrimination to enforce this
authoring guidance.

### Resolved request and answer schemas

Core owns Zod schemas for the Seqlane classifier request and result. Input
state must be a JSON string, object, or array. Question IDs and instruction
strings must be nonempty. The resolved question map must exactly match
`questionKinds`.

| Kind | Resolved fields | Constraints | Validated answer |
| --- | --- | --- | --- |
| Choice | `instructions: string`, `criteria: Record<string, string \| null>` | 2–255 distinct, nonempty option IDs | `type: "choice"`, selected key, probability for every option, confidence |
| Score | `instructions: string`, `criteria: string[]` | 2–10 nonempty, distinct levels in order | `type: "score"`, weighted numeric score, matching legend, probability for every level, confidence |
| Noul | `instructions: string`, optional `{ true: string, false: string }` criteria | Both descriptions when criteria is present | `type: "noul"`, probability of yes in `[0,1]` |

Choice and Score probabilities and confidence must be finite numbers in
`[0,1]`. Each distribution must cover exactly the resolved options/levels and
sum to 1 within `0.001` to allow response rounding. Choice must name one of
its options. Score must be finite and lie in `[0, levels.length - 1]`; its
legend must map zero-based indices to the resolved level descriptions. Noul
has no separate confidence. `model` must be a nonempty string; usage token
counts must be nonnegative integers. The runtime validates both the static
result schema and its relationship to the resolved request before returning
the original response object. Use Zod passthrough/loose objects at every
response object level so validated provider extensions survive unchanged; do
not coerce or rename documented fields.
No unchecked `response.json()` or assertion can bypass these schemas.

### Private System One transport

The private client sends `POST <configured full endpoint URL>` with
`Content-Type: application/json`, optional `Authorization: Bearer <token>`,
and `{ model, state, questions }`. It inserts the declared `type` for each
resolved question. It reads a bounded JSON response and validates it as
untrusted data. The first implementation supports Jev's documented response
shape. Use native `fetch`; do not add an SDK dependency for this transport.

The request and response body limits are 1 MiB each, measured as UTF-8 bytes.
Oversize input or output fails with a typed error. A URL must be absolute with
no embedded username/password, query, or fragment. Allow HTTPS endpoints and
HTTP loopback endpoints for a future local server. Disable HTTP redirects so
the token cannot follow a redirect. A non-loopback endpoint requires a token.
Do not put the token in error messages, trace attributes, or exception causes
that are serialized to consumers.

The runtime owns one classifier client per run and exposes its `classify`
operation through the task execution context. `defineClassifierTask` supplies
the task's ordinary `execute` callback, which calls that operation. This keeps
Mastra and HTTP types out of core. Extend the existing runtime context assembly
in `libs/runtime/src/runtime/local/task-execution.ts`; pass the connection from
application composition through `startWorkflowRun` and runner execution
resolution. The client is independent of `AgentRuntimeFactory` and must work
when the runtime profile is `local`.

The generated `execute` starts the 20-second monotonic budget, calls the
synchronous builder, validates its resolved request, and calls
`context.classify(request, { signal, timeoutMs: remainingMs })`. Core owns the
request/result contract; the runtime context caps `timeoutMs` at 20 seconds,
resolves the run connection, and performs the HTTP exchange. If the budget is
exhausted before `classify`, the factory throws a typed timeout without HTTP.
The client returns the validated original response to the generated `execute`;
the existing task-output parser then applies the generated output schema.

### Standalone and direct-run configuration

Add CLI flags `--classifier-url <full-url>` and `--classifier-model <id>`.
Require the pair when either flag is present. When a classifier is requested
without a connection, fail at `TaskContext.classify` before making HTTP,
following the existing lazy agent-adapter acquisition rule. Do not add a task
discriminator or inspect task callbacks to predict classifier use.
Read an optional bearer token from `SEQLANE_CLASSIFIER_API_KEY` in the runner
environment. Require it for a non-loopback URL. Never accept a token CLI flag.
The CLI-owned child process reads the secret directly and binds the private
connection from trusted parsed options; never copy the secret into IPC. The public
`RunRequest` IPC schema remains unchanged. `--dry` prints a Plan without
calling `build`, requiring credentials, or sending HTTP requests.

The programmatic `startWorkflowRun` entrypoint accepts a private classifier
connection supplied by the trusted caller. It validates the same fields and
uses the same client, deadline, and result schemas as the CLI. A run with no
classifier request needs no classifier configuration. A classifier-only run
needs no agent adapter. The runtime acquires the one connection lazily on the
first `classify` request; it does not inspect task definitions to preflight it.

### Observation and lifecycle

Record the resolved request and validated response on the classifier
invocation. This is one model exchange under the existing task/step identity.
Each retry is an attempt of that exchange, not a new task invocation. Record
attempt count, latency, returned model ID, and usage without placing raw state
or questions in metrics labels, progress strings, or terminal output. Preserve
raw JSON in the local detail/trace path governed by the observation contract.
Standalone runs release the client and keep no Seqlane-owned saved copy after
the run. Cancellation interrupts fetch and backoff, then the task settles
before its Mastra step closes.

## Failure and edge cases

- Missing or invalid connection fails when a classifier is requested, before
  HTTP, with a typed configuration error; a Plan-only dry run remains possible.
- Invalid builder output, changed/missing question keys, empty Choice options,
  invalid Score levels, or non-JSON state fails before HTTP.
- Empty question maps are rejected at definition time. An empty workflow input
  is valid only when its declared schema accepts it.
- HTTP/auth/validation errors and malformed responses fail the task; they do
  not become `false`, zero, an empty distribution, or a different model.
- Retry exhaustion and deadline expiration preserve the last cause in a typed
  error. Cancellation takes precedence over a concurrent provider response.
- A `Retry-After` longer than remaining time ends the invocation without an
  extra attempt.
- Classifier result fields are data. Any later policy that promotes a
  probability to an action must be an explicit task or workflow condition.

## Migration

No existing task, Plan, adapter, or CLI invocation changes behavior. Add the
new factory and context operation. Update the public authoring and CLI docs
when implementation lands. Do not reclassify existing agent tasks silently.

## Verification

1. Core tests: static and dynamic builders, inferred fixed answer keys/kinds,
   exact question-key validation, input parsing before `build`, and runtime
   options/levels validation. The generated output schema must parse the full
   result and reject malformed or wrong-kind answers.
2. Private transport tests with a local HTTP fixture: exact Jev request and
   bearer header, all three answer kinds, missing/extra answers, malformed
   probabilities, wrong legend, bad JSON, response limits, redirects, auth
   failures, and no token leakage.
3. Fake-clock or bounded integration tests: up to four attempts within one
   20-second deadline, `Retry-After`, nonretryable status, abort during fetch
   and backoff, and cancellation precedence.
4. Runner and direct API tests: classifier-only flow under `local`, classifier
   plus agent flow, lazy missing configuration failure, unchanged IPC/Plan, and
   `--dry` without credentials. Check the public package boundary for Mastra
   and provider SDK type leaks.
5. Example test: the existing Git diff example sends its bounded evidence to
   the local HTTP fixture and returns full Choice, Score, and Noul answers.
   A live Jev smoke run is optional and requires an operator-provided key;
   record it separately from deterministic CI evidence.
6. Run test mapping before scoped tests. Then run affected typecheck, lint,
   build, tests, public boundary checks, forbidden `/ee/` import check,
   `pnpm docs:index`, and `pnpm docs:validate`.

## Acceptance criteria

- A classifier-only workflow runs without `--adapter` and returns the full
  validated Jev result through the existing task and workflow output path.
- Different inputs to one task produce different instructions, Choice options,
  and Score levels while question IDs and kinds remain fixed.
- One invocation sends exactly one state and all declared questions in each
  attempt. No model call occurs during Plan construction or `--dry`.
- Configuration and bearer token remain outside the Plan, runner IPC command,
  workflow definition, and terminal progress output.
- Transient failures retry no more than three times and all work stops by the
  20-second deadline or earlier cancellation.
- Full resolved request and response are inspectable in the permitted local
  observation path; standalone runs create no Seqlane artifact store.

## Delivery state

Active implementation contract. No implementation is claimed. Delivery tasks
must record tested behavior and target-branch evidence before completion.

## Traceability

- [prd.seqlane-on-mastra, classifier requirement](../prd/2026-09-03-seqlane-on-mastra.md#requirement-classifier-tasks)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md#classifier-tasks)
- [adr.classifier-task-runtime-boundary](../adrs/2026-09-23-classifier-task-runtime-boundary.md)
- [spec.standalone-cli-runs](./2026-09-16-standalone-cli-runs.md)
- [spec.mastra-backed-seqlane-workflows](./2026-09-08-mastra-backed-seqlane-workflows.md)
- [spec.otel-aligned-observation-contract](./2026-09-19-otel-aligned-observation-contract.md)
- [TypeSafe API reference](https://docs.typesafe.ai/api)
- [Jevais inspiration](https://github.com/ivo-toby/jevais)
