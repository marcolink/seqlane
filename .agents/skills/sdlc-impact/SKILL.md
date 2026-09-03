---
name: sdlc-impact
description: Assess which Seqlane SDLC documents must change before implementation or planning work begins.
---

# SDLC impact

Run this skill before meaningful implementation or architecture work. Produce a
documentation impact assessment before code changes start.

## Inspect

1. Read `AGENTS.md`, `docs/sdlc/AGENTS.md`, and `docs/sdlc/index.md`.
2. Inspect the request, current Git status, changed files, and relevant source.
3. Search type indexes and active specs for affected terms, contracts, and
   boundaries.
4. Trace upward only when product intent or architecture rationale is needed.
5. Find the existing task. If no bounded task owns the work, create or update
   one through `sdlc-author`.

Do not treat a task as authority for requirements. Do not let code silently
change an active spec or public behavior.

## Classify the change

Choose one primary classification:

- implementation-only;
- contract change;
- architecture change;
- product requirement change;
- business-scope change.

Use these triggers for mandatory analysis:

- public workflow DSL;
- workflow or task visibility;
- schemas;
- session topology;
- workspace policies;
- executor contracts;
- Work identity or provenance;
- CLI behavior;
- Mastra integration boundaries;
- OpenCode or ACP integration.

For each affected document, decide `no change`, `update`, or `create`. Check
whether an existing document already owns the concern before proposing a new
one. Recommend an ADR or RFC when the change alters architecture. Recommend a
PRD or BRD change when it alters product behavior or business scope.

## Required output

Use this format:

```md
## Documentation impact

Classification: contract change

- PRD: no change
- RFC: no change
- SPEC: update `spec.<slug>` — describe the changed contract
- TASK: update `task.<slug>` — bound the implementation work
- ADR required: no

### Rationale

Explain the affected contract and the evidence.

### Required work

List document edits in dependency order.

### Open questions

List only questions that block correct document ownership or scope.
```

Do not claim `no change` without checking the active spec and its upstream
constraints. If the impact is unresolved, stop implementation and report it.
