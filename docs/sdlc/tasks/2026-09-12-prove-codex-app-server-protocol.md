---
id: task.prove-codex-app-server-protocol
title: Prove the Codex App-Server Protocol
status: in-progress
owners:
  - core
created: 2026-09-12
updated: 2026-09-12
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

## Completion criteria

- The selected version and required protocol shapes are recorded and reproducible.
- Every advertised capability has evidence from the pinned app-server.
- A failed probe blocks capability claims instead of enabling a fallback.

## Outcome

Added an opt-in JSONL probe with bounded framing, request correlation, typed
output validation, exact checkpoint fork capture, interruption capture, and
approval-request interruption without a decision response. Deterministic
fake-server tests cover the complete sequence without a live model.

## Delivery state

Live confirmation is pending because the probe requires credential-backed
external model execution. No live protocol claim is recorded yet.

## Traceability

- [spec.codex-app-server-adapter](../specs/2026-09-12-codex-app-server-adapter.md)
- [OpenAI Codex App Server documentation](https://developers.openai.com/codex/app-server)
