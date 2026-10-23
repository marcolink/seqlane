---
id: spec.runtime-user-input
title: Structured Runtime User Input
status: active
owners:
  - core
  - runtime
created: 2026-10-23
updated: 2026-10-24
upstream:
  - prd.seqlane-runtime
  - adr.runtime-user-input
supersedes: []
---

# Structured Runtime User Input

## Summary

An agent can request structured user input during an enabled run. Questions
are created during execution. The runtime validates answers and returns them
to the same agent invocation.

This is the active target contract. Disabled runs retain autonomous behavior.
Implementation evidence is tracked separately in the linked delivery task.

```text
Before: running -> question -> invocation.failed -> run.failed
After:  running -> waiting_for_input -> answer -> running -> task output
                                    -> cancellation or failure
```

## Goals

- Support questions from skills without upfront question declarations.
- Keep workflow input, output, and Plan contracts unchanged.
- Validate every request and answer through shared schemas.
- Preserve autonomous defaults, cancellation, session order, and workspace ownership.
- Prove one live agent round trip through the child runner and terminal CLI.

## Non-goals

Permission approval, arbitrary forms or JSON Schema, file uploads, secret
entry, multiple selections, and predefined human workflow steps are outside scope.
Background notifications, hosted delivery, persistence, and recovery after
restart also require separate contracts.

## Terminology

| Term | Meaning |
| --- | --- |
| Interaction | One pending tool call with one or more questions |
| Question | One required text or single-choice answer within an interaction |
| Request ID | Runtime-generated identity for one interaction within a run |
| Consumer | The connected process that presents questions and submits answers |
| Waiting | A live invocation that cannot continue its tool call without input |
| Answered | The runtime accepted a valid answer, not proof of agent delivery or task success |

## Requirements

### requirement-policy

The run owns the interaction policy. Omission means `{ mode: "disabled" }`.
The `run.start` field is:

```ts
const interactionPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("disabled") }),
  z.strictObject({
    mode: z.literal("user-input"),
    timeoutMs: z.number().int().min(1_000).max(86_400_000),
  }),
]);
```

The CLI exposes `--interactive` and `--input-timeout <seconds>`.
The timeout defaults to 300 seconds and accepts integers from 1 to 86,400.
The timeout flag requires `--interactive`. The CLI converts seconds to
milliseconds before sending the run request.

Interactive CLI admission requires human output mode and usable terminal
input and output. CI mode, final-result JSON mode, and redirected streams
reject explicit interactive mode before the runner starts. A dry run validates
flag combinations but opens no question consumer and acquires no adapter.

An enabled run requires a consumer and an adapter with `userInput: true`
before its first agent invocation. A disabled run retains interaction failure
behavior. Unsupported native requests never receive guessed answers.
Deterministic-only runs do not acquire an adapter because of this flag.

Workflow authors do not declare questions or add a new DSL method in this
slice. The run policy permits interaction, but does not require an agent to
ask questions or guarantee that every skill can finish.

### requirement-agent-instruction

An enabled adapter must provide an actual callable question mechanism.
The logical tool name is `ask_user`. Native names remain adapter-private.
An adapter translates the following instruction to its actual tool name:

```text
When required information is missing, first inspect available context and tools.
If that information remains unavailable, call ask_user.
If a skill requires user input, use ask_user instead of asking only in prose.
Ask concrete questions. Provide choices when useful.
Do not invent answers. Continue only after the tool returns an answer.
Do not request passwords, tokens, or other secrets through ask_user.
An answer does not grant permission to execute an operation.
Follow the existing permission policy for approvals.
```

The instruction applies for the invocation's entire lifetime, including
skills discovered after execution starts. It does not rewrite skill files.
The adapter must preserve the workflow goal and harness instructions.

Disabled runs receive no instruction that advertises an unavailable tool.
Seqlane must not infer interaction requests from prose, final output, tool
names in text, or an unstructured skill message.

### requirement-question-contract

`libs/protocol` owns the canonical Zod schemas and inferred types. The adapter
reuses them. All objects are strict. The following excerpt defines the tool's
structural input, before the cross-field and byte limits below:

```ts
const inputIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const optionSchema = z.strictObject({
  value: inputIdSchema,
  label: z.string().min(1).max(256),
});
const questionSchema = z.strictObject({
  id: inputIdSchema,
  prompt: z.string().min(1).max(4096),
  options: z.array(optionSchema).min(1).max(20).optional(),
  allowFreeText: z.boolean(),
});
const userInputRequestSchema = z.strictObject({
  questions: z.array(questionSchema).min(1).max(8),
});
type UserInputRequest = z.infer<typeof userInputRequestSchema>;
```

Question IDs must be unique within a request. Option values must be unique
within a question. Reserved record keys `__proto__`, `prototype`, and
`constructor` are invalid identifiers. Prompts and labels must contain a
non-whitespace character. A question without options requires
`allowFreeText: true`. Every question requires an answer. There are no implicit
answers, selected defaults, or partial submissions.

An answer is a string keyed by question ID. The exact key set must match
the request. Without free text, the value must equal an offered option value.
With free text, any non-whitespace string of at most 8,192 characters is valid.
The runtime preserves submitted text. It never silently coerces an invalid
answer into a choice. An exact option value represents that choice.

The tool result uses this structural schema. Request-specific validation
additionally enforces the exact question IDs and allowed answers:

```ts
const userInputAnswerSchema = z.strictObject({
  status: z.literal("answered"),
  answers: z.record(inputIdSchema, z.string().min(1).max(8192)),
});
type UserInputAnswer = z.infer<typeof userInputAnswerSchema>;
```

The full encoded request event and response command each have a 64 KiB UTF-8
limit. These limits apply before retaining or forwarding data. Schema-owned
cross-field validation enforces uniqueness, answer compatibility, and limits.
Do not maintain separate handwritten runtime predicates.

The consumer renders choices and text from this format. Arbitrary HTML,
scripts, executable schemas, and external schema references are unsupported.
Terminal controls in untrusted display text must not execute.

### requirement-adapter-boundary

Add `userInput: boolean` to adapter capabilities. Missing capability during
migration means unsupported. Capability validation must cover this field.
Interactive admission fails before model execution when support is absent.

The request boundary gains an optional asynchronous operation:

```ts
// AgentAdapterRequest addition; types come from owning schemas.
requestUserInput?: (
  request: UserInputRequest,
) => Promise<UserInputAnswer>;
```

`UserInputAnswer` has the shape `{ status: "answered", answers }`.
The existing invocation abort signal governs the operation. Cancellation,
timeout, or channel failure rejects it through typed domain errors.
An absent operation means disabled interaction, not permission to use stdin.

The adapter validates the native payload, converts it to the canonical
request, and awaits the operation. It then validates and sends the native
answer. Native request IDs, SDK objects, and continuation handles stay private.
The adapter must preserve a native question's semantics without guessing.
An unrepresentable question fails with a typed unsupported-question error.

The first supported adapter must prove a native question operation or tool
registration with the installed harness. Its existing final-output contract
must still work after the answer. A prompt-only simulation does not qualify.

### requirement-identity-and-protocol

The runtime generates request IDs. The model cannot choose them. Each request
binds to the actual run, invocation, and execution attempt. Repeats and retries
must never reuse a request ID or accept an earlier attempt's response.
The runtime maps attempt identity privately when existing invocation identity
does not distinguish attempts.

Use the existing event envelope: `workId`, `runId`, `invocationId`, subject,
applicable task and iteration identity, and event metadata. Add these payloads:

| Message | Direction | Additional fields |
| --- | --- | --- |
| `interaction.requested` | Runner to consumer | `requestId`, `kind: "user-input"`, `questions`, `expiresAt` |
| `interaction.respond` | Consumer to runner | `runId`, `invocationId`, `requestId`, `answers` |
| `interaction.response` | Runner to consumer | Echoed response identity, `status: "accepted"` or `"rejected"`, rejection `code` when applicable |
| `interaction.resolved` | Runner to consumer | `requestId`, `status: "answered"`, `"cancelled"`, `"expired"`, or `"failed"`; safe failure `code` when applicable |

`expiresAt` is a UTC timestamp. The runtime uses a monotonic timer to enforce
the corresponding deadline. `interaction.response` is a control acknowledgment
with existing event metadata. It does not claim invocation lifecycle identity
for unknown requests. It echoes submitted IDs without inventing a subject.

The runtime registers a pending request before emitting `interaction.requested`.
Request registration and answer admission are serialized with cancellation.
The emitted question definition is immutable for that request ID.
It validates responses against the stored request, never a schema supplied
with the response. It sends `interaction.response` before resolving the tool
operation. An accepted response also emits exactly one `interaction.resolved`.

Accepted means the runtime accepted the answer. It does not mean the native
agent received it. Native delivery failure fails the invocation through the
existing adapter error path. Uncertain delivery never triggers an automatic
resend, invocation restart, or replacement prompt.

Invalid answers receive `INVALID_ANSWER` and leave the request pending.
Other response codes are `UNKNOWN_REQUEST`, `WRONG_INVOCATION`,
`WRONG_RUN`, `REQUEST_CLOSED`, and `RESPONSE_CONFLICT`.
An identical duplicate of an accepted answer receives `accepted` again.
It never emits another resolution or delivers a second native answer.
A different answer after acceptance receives `RESPONSE_CONFLICT`.
Answer equality compares exact key/value pairs, independent of key order.
Cancelled, expired, and failed requests return `REQUEST_CLOSED`.

Malformed protocol envelopes retain the runner's strict protocol-error
behavior. Well-formed but invalid answers must not fail unrelated invocations.
Both sides ship together in the first release. This proposal adds no support
for mixed-version CLI/runner pairs or remote authenticated response APIs.

### requirement-lifecycle

```text
request:    pending -> answered | cancelled | expired | failed
invocation: running -> waiting_for_input -> running -> existing terminal state
```

The invocation remains active while waiting. `waiting_for_input` is a
projection of pending interaction events, not an invocation result or a
workflow output. It must remain distinct from waiting for workspace admission.
Accepting an answer clears this input wait. Native answer delivery remains
active invocation work and can still fail before agent continuation.
The run remains active with a pending-input count. Independent invocations
continue when resource and session rules permit them.

Each invocation permits one pending interaction. Independent invocations can
have concurrent interactions. The consumer presents one request at a time in
event order and shows the pending count. Queued requests keep their deadlines.
An additional simultaneous request in the same invocation fails that invocation
with `CONCURRENT_USER_INPUT_UNSUPPORTED`. Terminal cleanup closes its first request.

The runtime retains active processes, session locks, workspace leases, and
execution slots during the wait. It must not admit conflicting work while
the agent can still mutate its workspace. Dependents wait for final output.

The input timeout starts at registration. Existing invocation and run
deadlines continue without reset or extension. The earliest deadline wins.
An input deadline expires the request and fails the invocation with
`USER_INPUT_TIMEOUT`. An earlier execution deadline keeps its existing timeout
error and resolves the request as expired.

The runtime serializes response admission and terminal transitions. A
response processed at or after the deadline cannot win. Cancellation accepted
before response admission closes the request and prevents answer delivery.
Cancellation after admission still aborts the invocation. It cannot retract
an answer already sent to the native agent.

Each admitted request emits exactly one terminal resolution before the
invocation's terminal event, while the event channel remains available.
Final agent completion with a pending request fails with
`USER_INPUT_PROTOCOL_ERROR`. It must not silently discard the question.

Retain duplicate-response records until the run ends. Store answer digests
after delivery rather than an additional plain-text copy. Use canonical key
ordering for the digest. Bound admitted requests to 256 per run. Further
requests fail their invocation with `USER_INPUT_LIMIT_EXCEEDED`.
No request records survive the standalone run.

### requirement-consumer-and-observability

The CLI owns terminal input and the runtime owns interaction state. The adapter
never reads stdin or renders prompts. The human renderer must coordinate
progress output with the active question so that keystrokes reach one owner.
Invalid answers keep their editable form and show a safe validation message.

Escape or the explicit cancel control cancels the whole run through
`run.cancel`. There is no implicit skip or rejection answer. EOF and terminal
loss cancel an interactive CLI run. The runner also cancels when its parent
control channel closes. Cleanup follows existing process termination rules.

Protocol events are canonical. Activity truncation cannot remove a pending
request, resolve it, or prevent cancellation. The UI derives waiting state
from interaction events, not from text or native telemetry.
Resolution and acknowledgment events contain no answer values. Generic
diagnostics and metrics must not copy answers. Apply existing redaction to
native observations that contain tool arguments or results. Consumers must
not rewrite option values during display redaction.

This channel is not for secrets. User answers reach the native agent and can
enter its own transcript storage. The standalone run adds no durable Seqlane
question or answer history. Durable replay and reconnection remain unsupported.

## Detailed design or contracts

The following logical tool call comes from a skill during agent execution:

```ts
ask_user({
  questions: [{
    id: "region",
    prompt: "Which region should host this preview?",
    options: [
      { value: "eu-west", label: "Europe" },
      { value: "us-east", label: "United States" },
    ],
    allowFreeText: false,
  }],
});
```

The runtime emits the request with `requestId: "question-3"`. The consumer
sends this command. The runtime uses its own identity binding and stored
question definition to validate it:

```ts
{
  type: "interaction.respond",
  runId: "run-42",
  invocationId: "invoke-7",
  requestId: "question-3",
  answers: { region: "eu-west" },
}
```

The tool receives `{ status: "answered", answers: { region: "eu-west" } }`.
The agent continues in the same invocation. A later task receives only the
agent task's declared, validated output.

| Owner | Responsibility |
| --- | --- |
| `libs/protocol` | Canonical Zod schemas, command/event validation, serialized contracts |
| `libs/adapter` | Engine-independent capability and asynchronous request boundary |
| Concrete adapter | Native tool availability, instruction mapping, native response and cancellation |
| `libs/runtime` | Policy admission, pending requests, deadlines, identity, events, resource lifetime |
| `apps/cli` | Flag validation, consumer lifetime, response commands, cancellation |
| `libs/tui` | Question presentation, input controls, waiting-state projection |
| `libs/core` | Existing public authoring and output contracts; no agent SDK or engine types |

## Failure and edge cases

- Disabled input: existing `InteractionRequiredError` and task failure.
- Unsupported adapter: fail admission before model execution.
- Permission request: existing permission policy or interaction failure, never `ask_user` approval.
- Invalid native question: typed adapter failure, no inferred prose fallback.
- Invalid answer: rejection acknowledgment, request remains pending until its deadline.
- Timeout, cancellation, or disconnect: close pending state and stop the native wait.
- Adapter delivery uncertainty: fail without automatic retry or session replacement.
- Runner crash: the live interaction is lost. Saving its event cannot recover the native continuation.

## Migration

The ADR and this specification are active. The following owners carry the
corresponding requirements:

| Document | Required change |
| --- | --- |
| `prd.seqlane-runtime` | Activate proposed input behavior; qualify universal non-interactive and passive-terminal requirements |
| `adr.autonomous-non-interactive-execution` | Mark superseded by `adr.runtime-user-input`; preserve historical rationale |
| `spec.autonomous-non-interactive-execution` | Retain disabled-policy failure rules; delegate enabled input to this spec |
| `spec.agent-adapter-boundary-and-capabilities` | Add input capability and asynchronous operation |
| `spec.effect-v4-execution-and-operations` | Add policy, responses, acknowledgments, disconnect behavior, and event variants |
| `spec.run-terminal-rendering` | Add explicit interactive mode and pending-question projection |
| `spec.codex-app-server-adapter` | Qualify input rejection only if the first adapter proof succeeds |

The existing runtime RFC retains engine ownership. This feature adds no new
runtime engine, canonical run store, or workflow persistence. A separate RFC
is unnecessary for the live scope. OpenCode support remains unchanged.

No public CLI guide advertises these flags until implementation is verified.
The first delivery task must update nearby docs and the public CLI guide.

## Verification

Run test mapping before implementation tests. Required evidence includes:

1. Schema and serialization tests for round trips, unknown fields, limits,
   duplicate IDs, unsupported questions, and malformed answers.
2. One real native tool request through adapter, runtime, child-runner IPC,
   terminal consumer, response validation, and native continuation.
3. A skill loaded during that run triggers the question. Its answer changes
   the final validated task output without a second invocation.
4. Deterministic race tests cover duplicate/conflicting answers, wrong IDs,
   stale attempts, deadline equality, cancellation, EOF, and delivery failure.
5. Concurrent invocations preserve request routing, workspace leases, and
   shared-session ordering. Dependent tasks receive no premature output.
6. Autonomous, permission, structured-output, and deterministic-task regression
   tests pass. Deterministic runs make zero model calls.
7. A real PTY run proves prompt/progress coexistence and cancellation.
   CI, JSON, and redirected interactive admission fail before execution.
8. Activity truncation leaves pending input usable. Diagnostics and terminal
   controls respect redaction and display boundaries.

Fixtures prove internal behavior. They do not prove native tool availability.
Record the exact adapter/harness version and same-session evidence for the
live test. If the proof fails, retain unsupported capability and report the gap.

## Acceptance criteria

- A skill asks a runtime-defined question through an actual structured tool.
- The CLI presents the question and validates a complete answer.
- The answer reaches the original native continuation at most once.
- The same invocation returns its declared output after the answer.
- Disabled runs preserve current behavior and never wait for input.
- Permission policy, cancellation, deadlines, and resource ownership remain intact.
- A consumer cannot answer another run, invocation, or stale attempt.
- Documentation distinguishes live waiting from durable suspension.

## Delivery state

Active contract. The linked task records local implementation and native
acceptance evidence on `feat/runtime-user-input`, based on `origin/next` at
`ba0c073`. No target-branch delivery is claimed.

## Traceability

- [prd.seqlane-runtime: runtime user input](../prd/2026-10-21-seqlane-runtime.md#requirement-runtime-user-input)
- [adr.runtime-user-input](../adrs/2026-10-23-runtime-user-input.md)
- [task.runtime-user-input-round-trip](../tasks/2026-10-23-runtime-user-input-round-trip.md)
- [spec.autonomous-non-interactive-execution](./2026-09-02-autonomous-non-interactive-execution.md)
- [spec.agent-adapter-boundary-and-capabilities](./2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [spec.effect-v4-execution-and-operations](./2026-10-21-effect-v4-execution-and-operations.md)
- [spec.run-terminal-rendering](./2026-09-15-run-terminal-rendering.md)
- [spec.codex-app-server-adapter](./2026-09-12-codex-app-server-adapter.md)
- [rfc.effect-v4-migration](../rfcs/2026-10-21-effect-v4-migration.md)
