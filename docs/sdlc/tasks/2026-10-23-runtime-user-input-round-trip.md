---
id: task.runtime-user-input-round-trip
title: Deliver One Live User Input Round Trip
status: completed
owners:
  - core
  - runtime
created: 2026-10-23
updated: 2026-10-27
upstream:
  - spec.runtime-user-input
supersedes: []
---

# Deliver One Live User Input Round Trip

## Objective

An agent loads a skill, asks a structured question, receives the user's
answer through the CLI, and completes the same invocation.

## Upstream requirements

Implement [spec.runtime-user-input](../specs/2026-10-23-runtime-user-input.md).
The accepted ADR and active spec preserve autonomous defaults while adding
explicitly enabled user input.

## Scope

One concrete adapter, the local terminal consumer, canonical input schemas,
run policy, runner IPC, cancellation, and the complete bounded question format.
Codex is the first supported adapter. Its native dynamic tool carries the
question and returns the validated answer to the same invocation.

## Out of scope

Additional adapters, permission approvals, arbitrary forms, hosted UI,
notifications, durable storage, reconnect, restart recovery, and new workflow DSL.

## Implementation plan

### Tracer bullet

- **Outcome:** one real skill question changes the final validated task output.
- **Path:** CLI opt-in -> child runner -> agent adapter -> native question tool
  -> runtime request -> terminal input -> IPC response -> same native continuation.
- **Risk:** the installed harness might not expose a usable question tool in
  its normal execution mode, or might not preserve the final-output contract.
- **Evidence:** record the harness version, native tool request/response shape,
  same session and invocation identity, and final validated output. Use a
  controlled fixture skill and non-sensitive answer.
- **Excluded:** multiple consumers, other adapters, arbitrary form fields,
  durable recovery, and permission responses.

1. Activate the linked ADR and spec. Update the existing contracts listed in
   the spec's Migration section. Recheck source paths on the implementation base.
2. Inspect the installed native protocol and tool registration path. Prove a
   question and response with a bounded probe before implementing broad UI work.
   If a disposable probe is necessary, retain its evidence, not prototype code.
3. Deliver the end-to-end tracer with one text question. Include cancellation,
   a deadline, strict validation, autonomous defaults, and the real child runner.
   If the native continuation proof fails, keep the adapter unsupported.
4. Extend the same path to choices, free-text alternatives, and question
   batches. Verify that a runtime-loaded skill can trigger the input tool.
5. Prove repeated questions, concurrent invocations, duplicate answers, stale
   identities, deadlines, terminal loss, and uncertain native delivery.
6. Update the public CLI guide and adapter support docs after the real proof.
   Reconcile SDLC delivery state with the actual commit and test evidence.

The first complete tracer can land independently with other adapters marked
unsupported. Later slices extend that same contract. Select the current
target branch at implementation time. This planning task defines no PR stack.

## Affected areas

- `libs/protocol/src/runner-protocol.ts` and `validation.ts` for schemas and IPC.
- `libs/adapter/src/index.ts` for capability validation and the input boundary.
- `libs/codex/src/turn-tracker.ts` and adapter integration for native input.
- `libs/runtime/src/runner/` and invocation execution for policy and lifecycle.
- `apps/cli/src/` and `libs/tui/src/` for terminal admission and presentation.
- Public CLI and adapter documentation, plus the SDLC owners listed in the spec.

These paths reflect this checkout. They do not prescribe a runtime-engine
change or justify placing all interaction responsibilities in one module.

## Verification

Run `pnpm test:mapping` before focused tests. Run relevant protocol, adapter,
runtime, CLI, and TUI tests, typechecks, and lint. Use a real PTY for the live
CLI proof. Cover every verification case in the linked spec before completion.

Run `pnpm docs:index`, `pnpm docs:validate`, the public docs build for changed
public pages, and `git diff --check`. Record fixture and live evidence
separately. Do not treat a mock adapter as proof of native input support.

## Completion criteria

- The full spec acceptance criteria pass for one real adapter and terminal CLI.
- The workflow definition needs no static question schema or task input change.
- The same invocation and native session continue after the answer.
- Autonomous behavior and permission rules retain their existing defaults.
- Failure paths stop native waits and preserve resource cleanup.
- Public docs identify supported adapters and the lack of restart recovery.

## Outcome

Implemented on `feat/runtime-user-input`, based on `origin/next` at `ba0c073`.
The CLI enables input with `--interactive`; omission retains autonomous behavior.
No workflow DSL or static question declaration was added.

The implementation includes canonical schemas, runner IPC, a bounded request
broker, the Codex `ask_user` tool, and a terminal question queue. Shared schemas
validate choices, text, identities, complete answer sets, and byte limits.
Canonical events drive waiting state. Cancellation and deadlines stop native
waits before resource cleanup completes.

### Review follow-up: unanswered native completion

The SEQ-PR183-005 follow-up in [PR #183](https://github.com/marcolink/seqlane/pull/183)
closes pending input when adapter execution settles. The runtime publishes the
failed input resolution before invocation failure. Late answers receive
`REQUEST_CLOSED`. The original adapter error remains the invocation failure.
Cancellation and execution deadlines retain their existing resolution states.

The broker regression verifies asynchronous resolution delivery and isolation
from another pending invocation. A compiled runner test uses the real Codex
adapter with a local protocol fixture. Codex completes with unanswered input
while independent work keeps the run active. The test verifies one failed
resolution, rejection of a late answer, and no native answer write.
This test does not invoke a live model.

Static quality analysis flags recent-edit churn in `executeAgentAdapterRequest`.
The lifecycle fix must touch this boundary. Input ownership stays in a separate
module; the follow-up does not refactor unrelated runner supervision.

### Native acceptance evidence

Verified with Codex CLI `0.164.0` and Node `24.16.0` on 2026-10-24.
A disposable skill asked for a region choice and a text note in one batch.
The real CLI, child runner, and Codex adapter completed the following exchange:

```ts
// Native tool request, created after the skill was loaded.
ask_user({
  questions: [
    {
      id: "region",
      prompt: "Which region should host this preview?",
      options: [
        { value: "eu-west", label: "Europe" },
        { value: "us-east", label: "United States" },
      ],
      allowFreeText: false,
    },
    {
      id: "note",
      prompt: "What note should accompany the preview?",
      allowFreeText: true,
    },
  ],
});
// Native tool result; the same invocation then returned the task output.
({ status: "answered", answers: { region: "eu-west", note: "live-round-trip" } });
// Validated task output; CLI exit status 0.
({ region: "eu-west", note: "live-round-trip" });
```

Run `f40bf5ab-adba-4aa8-b008-02c01f74ed39` retained invocation
`4b560f81-a1fc-4836-8582-4e230a69a846` through question, answer, and completion.
The native path used `thread/start.dynamicTools`, `item/tool/call`, and a
`contentItems` response with `success: true`. The initialize request enables
the native experimental API required by dynamic tools.

A separate native probe confirmed that `thread/fork` inherits the tool.
Parent `01a16adb-d5d4-7542-bd65-6034b3f41625` and fork
`01a16adb-e7a3-7c61-9be9-afe4719f3125` each called `ask_user` and completed.
The fork returned `{ "note": "fork-proof" }`.

Real PTY checks also covered Escape cancellation, with exit status 130,
and a one-second input deadline, with exit status 1. Deadline failure now
interrupts the native turn and confirms termination before returning the error.
The accepted answer remains distinct from proof of native delivery.

### Validation

Passed the full install, typecheck, test, lint, build, format, and Nx sync gates.
The test-mapping check covered 633 mappings. The CLI end-to-end suite passed
126 tests. Protocol, adapter, runtime, terminal-consumer, and Ink tests cover
invalid input, duplicates, routing, races, queued expiry, terminal loss,
uncertain writes, and pending-request completion.

Runtime boundary validation, SDLC validation, public documentation build,
and whitespace checks also passed. Subprocess verification explicitly selected
Node 24; earlier Node 23 runs were discarded as non-authoritative evidence.

Static analysis remains advisory evidence with recorded trade-offs. Ripwire
reported 29 major increases in existing functions, mainly orchestration and
test-fixture size. Native input handling was extracted, and event emission
reuses one sequencing path. Remaining integration branches stay with their
lifecycle owners to avoid a broader runtime refactor. The name-based test
gate cannot establish coverage through dynamic dispatch; repository mapping
and executed behavior tests provide that evidence. Neither static check is
reported as passing.

## Delivery state

Implementation and evidence are committed together on `feat/runtime-user-input`.
The target `origin/next` at `ba0c073` does not contain this change. No merged
pull request or target-branch delivery is claimed. Other adapters, hosted
consumers, and restart recovery remain outside this task.

## Traceability

- [spec.runtime-user-input](../specs/2026-10-23-runtime-user-input.md)
- [adr.runtime-user-input](../adrs/2026-10-23-runtime-user-input.md)
