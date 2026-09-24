---
id: adr.classifier-task-runtime-boundary
title: Add Classifier Tasks Through a Private Decision Connection
status: accepted
owners:
  - core
created: 2026-09-23
updated: 2026-09-23
upstream:
  - prd.seqlane-on-mastra
  - rfc.mastra-runtime-and-operational-foundation
  - adr.standalone-cli-runs
supersedes: []
---

# Add Classifier Tasks Through a Private Decision Connection

## Context

Jev and Laya evaluate a state against named Choice, Score, and Noul questions
and return probabilities. Laya exposes a Jev-compatible System One HTTP
endpoint. Workflow authors need these judgments as typed task outputs, with
question wording and criteria built from each invocation's input. A classifier
request does not need an agent goal, coding tools, or a conversation session.

Seqlane already uses one task/dataflow contract and Mastra as its only workflow
runtime. Standalone runs do not require a Seqlane configuration file and do not
persist Seqlane history. This decision adds a model-backed task without changing
those foundations.

## Decision

### decision-classifier-task-boundary

`defineClassifierTask` creates an ordinary in-memory task definition. It fixes
question IDs and kinds at definition time. Its `build` callback receives parsed
task input and resolves one JSON state plus instructions and criteria for those
questions at invocation time. Static requests use the same callback shape.
The task executes as one Mastra step through a private classifier client. The
Plan keeps its normal task ID and input binding, not a new node kind, callback,
provider request, or credential. It creates no agent session or checkpoint.

### decision-one-connection-per-run

Application composition supplies one classifier endpoint, model ID, and optional
bearer token for a run. Standalone CLI configuration uses explicit connection
flags and an environment secret; it adds no required configuration file. The
model ID is operator configuration and may be a pinned version or provider
alias. Classifier configuration is independent of the coding-agent `--adapter`.
No endpoint, model ID, or credential is embedded in the workflow definition or
serialized Plan.

### decision-system-one-first

The first implementation targets Jev's `POST /v1/systemone` request/response
shape using a private, validated HTTP client. Laya compatibility is a later
verification step. Seqlane does not adopt a third-party SDK or claim that this
provider-defined shape is a formal standard.

### decision-full-result-and-policy

The task returns the complete validated response: model, answers with all
probabilities and confidence fields, Score legends, Noul values, and usage.
Seqlane does not apply thresholds, abstain, or turn probabilities into Boolean
values. Later deterministic tasks own those policies. A failed request or
malformed response fails the invocation; it never becomes a negative answer.

## Alternatives considered

### Send questions through a coding agent

An agent introduces sessions, tools, generated text, and adapter requirements
that this task does not need. It also hides the provider's probability shape.
Rejected.

### Add a classifier Plan node or a second execution engine

Either choice duplicates existing task dataflow and Mastra step lifecycle.
Rejected.

### Put endpoint and credentials in the task definition

That couples portable workflows to a deployment and risks serializing secrets.
Rejected.

### Depend on a Jev convenience library

Its semantic helpers apply thresholds and expose a provider-specific surface.
The first Seqlane contract needs full results and a configurable endpoint.
Use its failure and uncertainty handling as design input, not as the runtime
contract.

## Consequences

- Core gains a classifier authoring factory and a Seqlane-owned context request
  contract. Private runtime composition supplies the HTTP client.
- Generated output schemas and response validation must check the resolved
  options and levels, not only the static answer shape.
- Agent model/session policy remains separate from classifier model selection.
- The first supported run has one classifier connection; there is no per-task
  provider routing or automatic fallback.
- Full request and response inspection follows the active observation and
  standalone retention contracts. Credentials never enter those payloads.

## Delivery state

Decision accepted on 2026-09-23. No classifier implementation is claimed.
Delivery is tracked by the linked specification and planned tasks.

## Traceability

- [prd.seqlane-on-mastra, classifier requirement](../prd/2026-09-03-seqlane-on-mastra.md#requirement-classifier-tasks)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md#classifier-tasks)
- [adr.standalone-cli-runs](./2026-09-16-standalone-cli-runs.md)
- [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md)
- [TypeSafe System One API](https://docs.typesafe.ai/api)
- [Laya HTTP server](https://github.com/NandhaKishorM/laya#self-hosting-http-server-jev-compatible)
