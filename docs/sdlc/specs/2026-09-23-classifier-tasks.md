---
id: spec.classifier-tasks
title: Classifier Task Contract
status: active
owners:
  - core
created: 2026-09-23
updated: 2026-09-24
upstream:
  - prd.seqlane-on-mastra
  - rfc.mastra-runtime-and-operational-foundation
  - adr.classifier-task-runtime-boundary
supersedes: []
---

# Classifier Task Contract

## Summary

Add `defineClassifierTask` for one input-derived state and many static typed
questions. Return a provider-neutral Seqlane result with validated answers,
model identity, usage, and opaque, bounded provider extensions. The first
private transport targets Jev System One HTTP. A standalone run supplies one
connection without an agent adapter or configuration file.

## Goals

- Preserve the existing `createFlow().task()` binding, Plan, Mastra step,
  validation, cancellation, and workflow-output paths.
- Support static Choice, Score, and Noul questions in one request over a state
  selected from parsed input.
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

- **Question kind:** `choice`, `score`, or `noul` for a named static question.
- **Resolved request:** the state produced by `state` for one validated task
  input, together with the task's static questions.
- **Classifier connection:** the private endpoint, model ID, and bearer token
  available to one run.
- **Attempt:** one HTTP POST. Up to three retries allow four attempts total.

## Requirements

### requirement-fixed-question-shape

The author declares a nonempty map of complete static questions. Each question
has a stable ID, kind, instructions, and kind-specific criteria. The `state`
callback receives validated task input and returns one JSON string, object, or
array. All questions share that state and go in one provider request. Question
answers do not become input to other questions in that request.

### requirement-full-result

The task returns a complete validated Seqlane classifier result without
thresholding or discarding provider data. Core owns Seqlane answer and result
types for Choice, Score, and Noul; it does not expose System One request or
response schemas. The result preserves model identity, answers, usage,
distributions, confidence, Score value and legend, and Noul probability.

The private transport maps documented provider fields into those Seqlane
types. It moves unrecognized JSON fields into opaque extensions on the
corresponding result, answer, or usage value. Extension keys and values remain
unchanged and use the same payload limits as other JSON data. Missing, extra,
or mismatched answer IDs fail. Probabilities are never converted to booleans.
Workflow decisions derived from them belong in ordinary downstream tasks.

### requirement-runtime-connection

One connection is selected for a run. A classifier task does not require
`--adapter`, a coding-agent model, a session, or a workspace read. A workflow
that also has agent tasks can use `--adapter` independently. Connection and
credential values never enter task definitions, Plans, runner IPC commands,
workflow outputs, or terminal progress events. The model returned by the
provider remains in the classifier task result.

The CLI parses the classifier URL and model flags and passes them to its runner
child through private startup environment variables. The child captures the
URL, model, and optional bearer token, then removes all three variables from
`process.env` before loading authored workflow code. The URL/model startup
variables are internal and are not public environment configuration. The
credential is read from `SEQLANE_CLASSIFIER_API_KEY` and is never placed in
argv or IPC. Direct startWorkflowRun callers supply a private connection
object.

### requirement-deadline-and-retries

Each classifier invocation has one 20-second transport budget. Start its
monotonic clock after the synchronous `state` callback has returned and the
resolved request has passed validation and serialization. The budget covers
HTTP attempts, response reading and validation, and backoff. Synchronous state
selection and request validation are bounded by the payload limits but are
outside this transport budget; do not claim a hard wall-clock bound over
authored synchronous code.

The first attempt may be followed by at most three retries on network failure,
HTTP 429, 529, or 5xx. Retry only the same endpoint and model. Respect
`Retry-After` only when it fits the remaining budget. Do not retry 400, 401,
403, 404, 422, malformed output, or caller cancellation. The first attempt and
every retry share the invocation's abort signal. Do not start another attempt
after the transport budget expires.

### requirement-complete-observation

Retain the resolved state, questions, and provider response at the classifier
invocation's observation boundary, with Work, Run, and Invocation identity.
Use the existing runtime `ExecutionObservationSink` and
`invocation.observation` protocol event. Put the exact JSON request and response
in `model.request` and `model.response`, and usage in `model.usage`. Keep one
observationId for the exchange and identify each retry with `attemptIndex`.
Runtime supplies the identity envelope.

The request observation contains no authentication header, bearer token, URL
credentials, or CLI startup environment. Do not place raw classifier values
in invocation.output, terminal progress, or metrics labels. Existing hosted
tracing and local event consumers may inspect the bounded observation event.
Standalone runs keep no Seqlane-owned saved copy after the run. Reject
oversized state or questions before sending; never truncate them silently.

## Detailed design or contracts

### Public authoring shape

`@seqlane/core` exports `defineClassifierTask` and the corresponding inferred
question/result types. This is illustrative TypeScript; implementation may
split the types into cohesive files without changing the behavior.

```ts
const classify = defineClassifierTask({
  id: "git-diff-classifier",
  input: classifierInputSchema,
  state: ({ diff }) => ({ diff }),
  questions: {
    area: {
      kind: "choice",
      instructions: "Which area deserves the first review?",
      criteria: {
        runtime: "Runtime behavior or execution lifecycle.",
        docs: "Documentation or examples.",
      },
    },
    priority: {
      kind: "score",
      instructions: "How urgent is review of this change?",
      criteria: ["Low", "Medium", "High"],
    },
    needsSecurityReview: {
      kind: "noul",
      instructions: "Does this change need security review?",
    },
  },
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

The factory generates a Zod output schema compatible with `TaskDefinition`.
TypeScript maps each static question ID to its answer kind. A Choice selection
has type `string` and is checked against the declared option keys. `state`
receives only `z.output<inputSchema>` after binding resolution and input
parsing. It runs once per task invocation, including each workflow-level
repeat. HTTP retries reuse the same resolved request. The callback receives no
token or provider client. The factory rejects caller-supplied `execute` and
`output` fields to prevent divergence.

`createFlow().task()` runs its binding against workflow references when it
builds the Plan. It does not call `state`; the runtime calls `state` after
resolving and validating the task's concrete input. A classifier definition is
kept in the in-memory registry. The Plan node remains `type: "task"` with its
existing task ID, input binding, dependencies, and policies. A classifier call
does not use an agent session. Authors omit `session` for classifier tasks.
Existing `createFlow().task()` session policy remains unchanged; do not add
classifier-specific Plan inspection or task discrimination to enforce this
authoring guidance.

### Resolved request and answer schemas

Core owns Zod schemas for the provider-neutral Seqlane request and result.
Input state must be a JSON string, object, or array. Static question IDs and
instruction strings must be nonempty.

| Kind | Resolved fields | Constraints | Validated answer |
| --- | --- | --- | --- |
| Choice | instructions and criteria map | 2–255 distinct, nonempty option IDs | selected key, probability for every option, confidence |
| Score | instructions and ordered criteria | 2–10 nonempty, distinct levels | weighted score, matching legend, probability for every level, confidence |
| Noul | instructions and optional true/false criteria | both descriptions when criteria is present | probability of yes in [0,1] |

Choice and Score probabilities and confidence must be finite numbers in [0,1].
Each distribution must cover exactly the declared options or levels and sum
to 1 within 0.001. Choice must name one of its options. Score must be finite
and lie in [0, levels.length - 1]; its legend must map zero-based indices to
the declared level descriptions. Noul has no separate confidence. Model
identity must be a nonempty string; usage token counts must be nonnegative
integers.

The private transport validates the provider response, maps known fields into
the Seqlane result schema, and preserves unknown JSON fields in opaque
extensions. Core types do not name provider wire envelopes or provider
extension fields. No unchecked response.json() or assertion can bypass these
schemas.

### Private System One transport

The private client sends POST to the configured full endpoint URL with
Content-Type application/json, an optional bearer header, and the System One
wire body containing model, state, and questions. It maps each declared
question `kind` to the provider `type`. It reads a bounded JSON response and
validates it as untrusted data. The first implementation supports Jev's
documented response shape. Use native fetch; do not add an SDK dependency.

Request and response bodies are each limited to 1 MiB measured as UTF-8 bytes.
Apply these generous structural limits to request state, provider responses,
and opaque extension data before recursive Zod validation and observation:

- Maximum container depth: 64, with the root value at depth 1.
- Maximum entries in one object: 8,192.
- Maximum entries in one array: 16,384.
- Maximum total JSON values and entries in one body: 65,536.
- Maximum UTF-8 size of one string: 256 KiB.
- Maximum serialized state: 768 KiB.
- Maximum questions per task: 256.
- Maximum question ID: 256 UTF-8 bytes.
- Maximum instructions: 64 KiB each.
- Maximum Choice option or Noul description: 16 KiB each.

Existing Choice and Score criteria limits remain 255 options and 10 levels.
Request and response body limits still apply to the complete document.
Oversize or structurally complex input fails with a typed error; output fails
with a typed response error.

A URL must be absolute with no embedded username/password, query, or fragment.
Allow HTTPS endpoints and HTTP loopback endpoints for a local server. Disable
HTTP redirects so the token cannot follow a redirect. A non-loopback endpoint
requires a token. Do not put the token in error messages, trace attributes, or
serialized causes.

### Standalone and direct-run configuration

Add CLI flags --classifier-url <full-url> and --classifier-model <id>. Require
the pair when either flag is present. The CLI sends the parsed URL and model
to the runner child in internal SEQLANE_RUNNER_CLASSIFIER_URL and
SEQLANE_RUNNER_CLASSIFIER_MODEL variables; these values never enter
`RunRequest`. The runner captures them and `SEQLANE_CLASSIFIER_API_KEY` before
workflow loading, then removes all three from `process.env`. No token CLI flag is
allowed. Require a token for non-loopback URLs.

When a classifier is requested without a connection, fail at
`TaskContext.classify` before HTTP, following the lazy agent-adapter rule. Do not
add a task discriminator or inspect task callbacks to predict classifier use.
The public `RunRequest` IPC schema remains unchanged. `--dry` prints a Plan
without calling `state`, requiring credentials, or sending HTTP requests.

The programmatic startWorkflowRun entrypoint accepts a private classifier
connection from the trusted caller. It validates the same fields and uses the
same client, deadline, and result schemas as the CLI. A run with no classifier
request needs no classifier configuration. A classifier-only run needs no
agent adapter. Resolve the connection lazily on the first classify request.

### Observation and lifecycle

The classifier client emits one terminal typed model observation through the
existing runtime `ExecutionObservationSink`. The runtime adds Work, Run, and
Invocation identity and forwards it as `invocation.observation`. A successful
attempt includes exact request JSON, validated response JSON, returned model
and usage, start/end times, and an observationId. A failed attempt includes the
bounded request, safe error text, and timing. It excludes an invalid response
and authentication data. Observation-sink errors propagate unchanged.

A single-attempt task emits `attemptIndex` 0. Retries in the later reliability
task reuse the same observationId and add their own `attemptIndex`; they do not
create new task invocations.

Keep raw JSON out of progress events, terminal output, and metrics labels.
The existing bounded invocation.output channel remains unchanged. Hosted
tracing and local event consumers use the existing observation path; no new
protocol event or Seqlane trace store is required. Standalone runs release the
client and retain no Seqlane-owned saved copy. Cancellation aborts fetch and
backoff, then the task settles before its Mastra step closes.

## Failure and edge cases

- Missing or invalid connection fails when a classifier is requested, before
  HTTP, with a typed configuration error; a Plan-only dry run remains possible.
- Invalid static questions fail when the task is defined. Invalid state fails
  before HTTP.
- Empty question maps are rejected at definition time. An empty workflow input
  is valid only when its declared schema accepts it.
- HTTP/auth/validation errors and malformed responses fail the task; they do
  not become `false`, zero, an empty distribution, or a different model.
- Retry exhaustion and transport-budget expiration preserve the last cause in
  a typed error. Cancellation takes precedence over a concurrent provider response.
- The transport budget starts after synchronous state selection, validation,
  and serialization.
- A `Retry-After` longer than remaining time ends the invocation without an
  extra attempt.
- Classifier result fields are data. Any later policy that promotes a
  probability to an action must be an explicit task or workflow condition.

## Migration

No existing task, Plan, adapter, or CLI invocation changes behavior. Add the
new factory and context operation. Update the public authoring and CLI docs
when implementation lands. Do not reclassify existing agent tasks silently.

## Verification

1. Core tests: static question validation, inferred fixed answer keys/kinds,
   input parsing before `state`, and state root validation. The generated
   output schema must parse the full result and reject malformed, extra, or
   wrong-kind answers.
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
- Different inputs to one task can produce different states while all declared
  questions remain fixed.
- One invocation sends exactly one state and all declared questions in each
  attempt. No model call occurs during Plan construction or `--dry`.
- Configuration and bearer token remain outside the Plan, runner IPC command,
  workflow definition, and terminal progress output.
- Transient failures retry no more than three times and transport stops within
  20 seconds after request construction, or earlier on cancellation.
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
