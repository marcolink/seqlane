---
id: task.correct-mastra-observability-tool-semantics
title: Correct Mastra Observability Tool Semantics and Storage Verification
status: planned
owners:
  - core
created: 2026-09-09
updated: 2026-09-09
upstream:
  - spec.mastra-native-agent-observability
  - spec.opencode-mastra-observability-projection
  - spec.acp-mastra-observability-projection
supersedes: []
---

# Correct Mastra Observability Tool Semantics and Storage Verification

## Objective

Make native Mastra tool telemetry identifiable, correctly typed, consistently
correlated, and demonstrably persisted. Preserve the existing private adapter
boundary, data-minimization policy, and native span-derived metrics.

## Documentation impact

Classification: contract change.

- PRD: no change. No user-visible Seqlane behavior changes.
- RFC: no change. The runtime remains Mastra-backed.
- ADR: no change. Adapter-owned projection remains the accepted decision.
- SPEC: update the three active Mastra observability specifications.
- TASK: this task owns the bounded implementation and verification work.

## Delivery

- Branch: `mastra-observability-tool-semantics`
- Pull request base: `mastra`
- Delivery unit: one task branch and one pull request
- Implementation: a fresh `gpt-5.6-luna` subagent at high reasoning; the
  primary agent reviews, validates, commits, and submits the change

## Scope

- In the OpenCode projector, use a validated normalized tool name as the
  `TOOL_CALL` span name. Keep `toolType` to `"tool"` or `"skill"` and retain
  `toolCallId` as the typed correlation attribute.
- Apply a bounded OpenCode tool-name cardinality budget and constant fallback
  equivalent in intent to ACP's existing name policy. Do not add tool input,
  output, or executor metadata to spans.
- In ACP, set `toolType: "tool"`; retain `acp-v1` only as namespaced agent
  metadata.
- Standardize private agent metadata as bounded `seqlane.invocationId`,
  `seqlane.adapter`, and, where available, `seqlane.attemptIndex`. Do not turn
  these values into tags, entity IDs, names, or metric labels.
- Add real storage-exporter integration coverage. Execute a representative
  OpenCode and ACP observation path, flush observability, retrieve the trace
  from Mastra storage, and assert span type, parentage, normalized tool name,
  typed attributes, correlation metadata, redaction, and terminal status.
- Audit `MastraPlatformExporter`. Remove it from the default local composition
  unless its use is explicitly permitted by the Community-only policy and its
  remote endpoint, credentials, retention, and operational owner are defined.

## Out of scope

- ACP model, provider, token, or cost telemetry. ACP v1 does not observe it.
- Raw prompts, transcripts, tool arguments, tool results, tool metadata, or
  unbounded error text.
- A generic executor observation model or shared executor projector.
- Changing public core, events, Plans, workflow APIs, runner IPC, or aggregate
  Seqlane callback contracts.
- Repricing OpenCode cost. Keep cost context absent until its SDK unit is
  verified.
- Treating OpenCode `endedAt` as Mastra's native end time; Mastra 1.64 does not
  accept an end timestamp on `end` or `error`.

## Implementation plan

1. Reconfirm the pinned `@mastra/core` 1.64.0 declarations and current
   OpenCode SDK observations. Record the typed `TOOL_CALL` allowlist and the
   unavailable end-time API in the change.
2. Update the active specifications in this task's upstream set before source.
   Keep completed 2026-09-08 task records historical.
3. Make the two adapter-local projections conform to the field contract.
   Preserve their independent parsers, reducers, failure isolation, and
   cardinality policies; do not create a generic projector.
4. Add deterministic span-sink regression tests for both field mappings and
   an integration test using `MastraStorageExporter` plus trace retrieval.
5. Resolve the Platform exporter policy. A rejected remote-export decision
   removes it from the default composition; an approved exception must add its
   configuration and operations contract before enabling it.
6. Run focused package tests/builds, test mapping, document indexing and
   validation, then inspect one persisted trace through the operational path.

## Affected areas

- `libs/seqlane-opencode/src/observability.ts`
- `libs/seqlane-opencode/src/observability.spec.ts`
- `libs/seqlane-acp/src/observability.ts`
- `libs/seqlane-acp/src/observability.spec.ts`
- `libs/seqlane-runtime/src/runtime/mastra/mastra-composition.ts`
- focused runtime storage/inspection test files
- the three upstream active specifications

## Verification

- `pnpm test:mapping`
- `pnpm nx test seqlane-opencode --skipNxCache`
- `pnpm nx build seqlane-opencode --skipNxCache`
- `pnpm nx test seqlane-acp --skipNxCache`
- `pnpm nx build seqlane-acp --skipNxCache`
- `pnpm nx test seqlane-runtime --skipNxCache`
- `pnpm nx build seqlane-runtime --skipNxCache`
- `pnpm docs:index`
- `pnpm docs:validate`
- `git diff --check`

Tests must prove that OpenCode and ACP create persisted `TOOL_CALL` spans with
the correct typed attributes and useful bounded names, while no raw tool
payload becomes persisted data. Tests must also prove no ACP model span and no
duplicate manual metric row.

## Completion criteria

- OpenCode tool spans are distinguishable by normalized tool name in stored
  traces.
- ACP no longer uses adapter identity as `toolType`.
- Both adapters use the same bounded, namespaced metadata vocabulary.
- Storage-backed trace tests prove the observed span tree and fields after
  exporter flush.
- Default exporter configuration satisfies the repository's Community-only
  policy.
- Public Seqlane contracts remain Mastra-free.

## Traceability

- [spec.mastra-native-agent-observability](../specs/2026-09-07-mastra-native-agent-observability.md)
- [spec.opencode-mastra-observability-projection](../specs/2026-09-08-opencode-mastra-observability-projection.md)
- [spec.acp-mastra-observability-projection](../specs/2026-09-07-acp-mastra-observability-projection.md)
- [adr.mastra-native-agent-observability](../adrs/2026-09-07-mastra-native-agent-observability.md)
