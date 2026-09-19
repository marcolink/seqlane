---
id: spec.opencode-executor-integration
title: OpenCode Executor Integration
status: superseded
owners:
  - core
created: 2026-09-02
updated: 2026-09-04
upstream:
  - adr.opencode-executor-integration
supersedes: []
---

# OpenCode Executor Integration

> Migrated from legacy technical specification `TS-004`.

## 1. Objective

Deliver `@seqlane/opencode` as the private adapter that lets the Seqlane runtime use an externally running OpenCode server.

Each Seqlane Run creates one new OpenCode session. The runner sends all MVP task invocations to that session in sequence.

```text
generic Seqlane task
        ↓
Seqlane Plan and in-memory task definitions
        ↓
Seqlane runtime Executor boundary
        ↓
OpenCode adapter and typed SDK client
        ↓
externally running OpenCode server
```

The MVP does not start, stop, or delete an OpenCode server. It does not delete a session that it did not create.

## 2. Normative Invariants

- `@seqlane/core` remains independent of OpenCode and Mastra.
- `@seqlane/runtime` remains independent of OpenCode SDK types and client objects.
- Only `@seqlane/opencode` imports the OpenCode SDK.
- OpenCode SDK types, clients, session IDs, message IDs, parts, events, and raw errors do not cross a public Seqlane boundary. The adapter may translate model/provider identifiers and response usage into the generic Seqlane invocation-metrics contract.
- A Seqlane Plan contains Seqlane data only. It contains no OpenCode request, schema, session, or message data.
- An OpenCode task keeps its executor-specific definition in memory with its workflow definition. The runner resolves it only inside the child process.
- A Run creates one new OpenCode session on the configured external server.
- All MVP OpenCode calls for one Run use that session and execute in Seqlane order.
- Independent Runs use different OpenCode clients, sessions, and cancellation state.
- Seqlane does not parse, copy, or rebuild `AGENTS.md`, OpenCode configuration, skills, agents, tools, plugins, MCP, or repository instructions.
- Seqlane additions are additive task input. They do not replace repository capabilities or select a provider, model, or agent.
- A declared task output requests adapter-owned structured output. The adapter uses native JSON Schema output only for verified compatible OpenCode versions; otherwise it uses prompt-based JSON and local validation. A JSON-looking response in ordinary text is accepted only by the prompt strategy when it is exactly one valid JSON value.
- Seqlane validates every raw structured result with the task output schema before it enters Seqlane dataflow.
- Cancellation aborts active OpenCode work. It never stops the external server.
- An unresolved permission or interaction state fails the invocation. The adapter never sends a permission response or reads terminal input.
- The MVP does not expose session attachment, named sessions, session forks, checkpoints, model profiles, native Harness Overlay installation, OpenCode event streaming, or concurrent task calls. Prompt-mode repair attempts are bounded within one task invocation and are not general task retries.

## 3. Package and Dependency Boundary

Create `libs/seqlane-opencode` as the private OpenCode integration package.

```text
@seqlane/core
        ▲
        │ declared dependency
@seqlane/opencode
        │
        ├── declared dependency: @opencode-ai/sdk
        └── structural runner-execution contract

@seqlane/runtime
        ▲
        │ Seqlane Executor boundary only
@seqlane/opencode
```

The package uses only exported SDK entry points. It does not import generated SDK files, `dist` paths, or source paths.

The bootstrap story must pin a tested SDK version in `pnpm-lock.yaml`. The same story must record the matching server compatibility rule.

The inspected `@opencode-ai/sdk@1.18.18` session prompt type has no structured-output schema parameter. The implementation must select and prove a public SDK/server API that accepts a schema and returns a structured value. Do not replace this requirement with prompt text that asks for JSON.

## 4. Private Adapter Binding

Workflow authors do not import this package. They use only generic core work:

```ts
const investigate = defineTask({
  id: "investigate-renovate-failure",
  input: investigateInput,
  output: investigationOutput,
  goal: (input) =>
    `Investigate the Renovate update for ${input.dependency}.`,
  instructions: ["Return the requested remediation evidence."],
})
```

The private adapter receives the in-memory agent task definition and output
schema after runtime resolution. It owns:

- conversion to the OpenCode request and structured-output format;
- SDK/session lifecycle, cancellation, and interaction failure handling; and
- private connection and request metadata.

The output schema provider and the Seqlane output validator describe the same logical result. The task factory must reject a missing or invalid structured-output schema before execution.

The objective function, instructions, references, and schema provider remain in memory. They do not enter the Plan, runner IPC, workflow output, or a public core type.

The factory does not accept a session ID, message ID, OpenCode client, model, provider, agent, tool override, permission response, or raw SDK value.

`buildWorkflow()` or an adjacent core-owned registry must retain the in-memory definitions that a runner needs to look up a task by task ID. The registry is not serialized and must remain valid when the same task appears more than once in one Plan.

An authored workflow module exports only its generic workflow. The child runner
resolves a runtime profile and creates the private adapter registry. No adapter
factory or connection data is exported by workflow source.

## 5. External Client and Session Lifecycle

The private runtime profile resolver gives the adapter its configured endpoint.
The adapter creates a typed SDK client for that endpoint and validates the
supported server contract before task work begins. The endpoint is not part of
the public runtime profile reference or runner protocol.

The compatibility validation must make sure that the server supports all required MVP operations:

1. create a session
2. submit a structured task request to that session
3. receive the final structured result
4. abort active work in that session.

If the endpoint is unreachable, the SDK/server contract is unsupported, or a required operation is unavailable, the adapter fails with a Seqlane executor error. It must not start a local OpenCode process or use an alternate CLI path.

After compatibility validation, the adapter creates exactly one session for the Run. It retains the opaque session ID only in run-scoped adapter state. It does not attach to, enumerate, delete, or otherwise alter an existing session.

The adapter serializes all calls for this session. spec.mastra-runtime-integration already serializes MVP Plan nodes. The adapter must also retain a session queue so later runtime scheduling cannot create interleaved messages by accident.

## 6. Invocation Translation and Result Boundary

For each Seqlane invocation, the runtime first resolves and validates input as defined by spec.mastra-runtime-integration. The adapter then:

1. finds the in-memory OpenCode task definition by `taskId`
2. builds the task objective from the validated input
3. adds task instructions and textual references without replacing the repository harness
4. selects native or prompt structured output inside the private adapter
5. submits the request to the Run session, with bounded prompt-mode repair when local parsing or validation fails
6. extracts the structured result and normalized response metrics from the supported OpenCode response
7. returns the result and Seqlane-owned metrics to the Seqlane runtime.

The normalized metrics may include response duration, model, provider, cost, and
input/output/reasoning/cache token counts. They contain no OpenCode SDK object,
prompt, tool output, transcript, or secret.

```text
validated Seqlane input
        ↓
objective and additive task context
        ↓
OpenCode structured-output request
        ↓
raw structured value
        ↓
Seqlane output schema validation
        ↓
typed downstream ValueRef
```

The adapter does not turn tool output, shell output, or OpenCode event payloads into a Seqlane result. Native mode does not parse assistant prose. Prompt mode accepts only direct JSON or one complete `json` Markdown fence, then validates it with the task's canonical output schema. Missing, malformed, or incomplete output fails after the configured repair bound.

The existing spec.mastra-runtime-integration output-validation boundary remains authoritative. OpenCode-side validation is an additional boundary only.

## 7. Failure, Cancellation, and Autonomy

The adapter converts transport, compatibility, session, response, and permission failures into normal executor failures. SDK error objects remain internal causes only.

When its `AbortSignal` fires, the adapter sends one abort request for the active session. It then rejects or resolves the active task according to the server terminal result. Repeated abort signals do not create repeated server abort requests.

An abort before a session is created prevents session creation. An abort after a session is created must not delete the session or stop the server.

The adapter does not use OpenCode APIs that submit a response to a permission, TUI, or user-input request. If the supported server contract reports unresolved interaction, the adapter fails the invocation with a clear Seqlane executor error.

Prompt-mode repair requests are not automatic task retries: they continue the same invocation and session, contain no repeated task execution request, and disable tools where OpenCode supports per-message restrictions. A native persisted-format readback failure is never replayed. It fails the current invocation and downgrades later `auto` selections for that runtime connection to prompt mode.

## 8. Required Tests

Use a local fake OpenCode HTTP server for deterministic unit and integration tests. The suite must assert requests and responses against the supported public SDK/server contract. It must not mock private SDK modules.

The test set must cover:

- package exports and declared dependency boundaries
- core and runtime builds that contain no OpenCode SDK imports or types
- typed task authoring, in-memory task lookup, and Plan serialization without OpenCode data
- endpoint compatibility failure and refusal to launch or stop an OpenCode process
- one new session per Run, one client per Run, and no session reuse across Runs
- four sequential Renovate-shaped invocations in one session
- a native structured-output request for every declared output schema
- independent Seqlane validation of valid and invalid structured results
- repository harness preservation and additive task context
- abort propagation to the active OpenCode session without server shutdown or session deletion
- deterministic failure for unresolved permission or interaction
- runner and CLI execution through the existing JSON-only IPC boundary.

A manual compatibility procedure can use an already-running OpenCode server. It must create only a Seqlane Run session and must not modify server lifecycle.

## 9. Acceptance Criteria

spec.opencode-executor-integration is complete when:

- `@seqlane/opencode` is the only package that imports OpenCode SDK types or client code
- a generic Seqlane task has typed input and output schemas, a validated objective, and additive task context without exposing raw OpenCode concepts
- task definitions stay in memory and Plans, core exports, and runner IPC remain free of OpenCode data and types
- the selected public SDK/server contract proves schema-backed structured output, session creation, final result retrieval, and abort support
- one external server connection creates one new session for each Run
- all MVP task calls for a Run are serialized through that session
- Seqlane revalidates every OpenCode structured result before downstream dataflow
- malformed structured output, server incompatibility, transport errors, and unresolved interaction fail through Seqlane-owned executor errors
- cancellation reaches active OpenCode work once and leaves the external server alive
- the runner and CLI retain their existing ownership and JSON-only protocol boundaries
- the Renovate-shaped workflow runs through the real adapter contract with a deterministic fake OpenCode server.

## 10. Explicitly Deferred

spec.opencode-executor-integration does not implement:

- Seqlane-managed OpenCode startup, shutdown, installation, or updates
- existing-session attachment, named sessions, session forks, checkpoints, or session persistence
- multiple OpenCode runtimes or concurrent OpenCode calls
- Seqlane model, provider, agent, tool, or permission profiles
- native installation of a Seqlane skill, tool, MCP server, or Harness Overlay capability
- Seqlane interpretation of repository harness files or OpenCode configuration
- session transcript persistence, recording/replay, or OpenCode debugging UI;
  live high-fidelity OpenCode observations are defined by
  `rfc.high-fidelity-local-observability`
- automatic retries, interactive permission approval, user input, or terminal reads
- non-OpenCode executors.

## 11. Delivery Order

1. Bootstrap the package and prove a supported public structured-output contract.
2. Add typed OpenCode task authoring and in-memory task definitions.
3. Add the external client, compatibility validation, and single-session lifecycle.
4. Translate validated invocations into structured OpenCode requests and results.
5. Wire the adapter into the runner and existing cancellation path.
6. Prove the Renovate workflow against the deterministic OpenCode server contract.

## Traceability

- [adr.opencode-executor-integration](../adrs/2026-09-02-opencode-executor-integration.md)
- Superseded by [spec.agent-adapter-boundary-and-capabilities](./2026-09-04-agent-adapter-boundary-and-capabilities.md).
