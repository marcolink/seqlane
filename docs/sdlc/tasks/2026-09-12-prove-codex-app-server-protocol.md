---
id: task.prove-codex-app-server-protocol
title: Prove the Codex App-Server Protocol
status: completed
owners:
  - core
created: 2026-09-12
updated: 2026-09-13
upstream:
  - spec.codex-app-server-adapter
supersedes: []
---

# Prove the Codex App-Server Protocol

## Objective

Establish the pinned Codex CLI and observed app-server contract before the adapter claims any capability.

## Upstream requirements

- [requirement-codex-protocol-proof](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-protocol-proof)
- [requirement-codex-model-selection](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-model-selection)
- [requirement-codex-typed-output](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-typed-output)

## Scope

- Select and pin a Codex CLI release for Seqlane integration checks.
- Build a controlled JSONL probe that starts `codex app-server` over stdio.
- Record request, response, notification, and error shapes for required methods.
- Prove model discovery, structured output, interruption, and exact fork position.
- Prove that a pending approval request can be interrupted without an approval decision.
- Record the supported version rule and any capability gaps in the integration spec.

## Out of scope

- Agent adapter implementation or runtime selection.
- Cross-run thread persistence, external sockets, or user-facing CLI options.
- A live model requirement for the normal repository test suite.

## Implementation plan

1. Inspect official app-server documentation and the selected CLI's generated schema or source.
2. Pin the executable version used by compatibility tests.
3. Exercise the handshake, thread, turn, model, fork, and interrupt methods.
4. Save sanitized fixtures for deterministic protocol tests.
5. Update the spec with proved shapes or a concrete unsupported capability.

## Affected areas

- Codex adapter test fixtures and version policy
- Codex integration specification
- CI setup for the protocol probe

## Verification

- Warn, but do not reject, a CLI version that is not in the confirmed version list.
- Reject a malformed protocol or unsupported required operation before task submission.
- Demonstrate that `lastTurnId` forks at the completed checkpoint.
- Demonstrate that `outputSchema` produces one locally validatable result.
- Demonstrate the terminal status after `turn/interrupt`.
- Demonstrate interruption while an approval request is pending.
- Continue with an advisory diagnostic when the version command fails.
- Cover agent-message deltas and completed-turn item collections.
- Bound pending protocol messages by count and aggregate bytes.
- Use a disposable workspace unless an explicit workspace is supplied.

## Completion criteria

- The selected version and required protocol shapes are recorded and reproducible.
- Every advertised capability has evidence from the pinned app-server.
- A failed probe blocks capability claims instead of enabling a fallback.

## Outcome

Added an opt-in JSONL probe split into focused CLI, protocol, transport, and
orchestration modules. It validates protocol envelopes and results, correlates
agent-message deltas and completed items, validates fork identity, bounds
transcript and pending-message memory, uses a disposable workspace by default,
and confirms interruption of a read-only turn while an approval request is
pending. It emits an advisory diagnostic when version discovery fails or finds
an unconfirmed CLI version. Deterministic fake-server tests cover the complete
sequence without a live model.

## Delivery state

Live confirmation completed against Codex CLI 0.147.0. The generated sanitized
fixture remains local and is intentionally ignored by version control.

## Traceability

- [spec.codex-app-server-adapter](../specs/2026-09-12-codex-app-server-adapter.md)
- [OpenAI Codex App Server documentation](https://developers.openai.com/codex/app-server)
