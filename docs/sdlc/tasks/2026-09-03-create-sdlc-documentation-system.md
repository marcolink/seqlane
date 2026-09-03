---
id: task.create-sdlc-documentation-system
title: Create SDLC documentation system
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.sdlc-documentation-system
supersedes: []
---

# Create SDLC documentation system

## Objective

Move the existing lifecycle corpus into the canonical type-based structure and
remove metadata, status, index, and link inconsistencies.

## Upstream requirements

- `C01` through `C09`.

## Scope

- Classify and move existing lifecycle documents.
- Normalize IDs, metadata, statuses, links, and traceability.
- Merge standalone MVP scope and the duplicate adr.invocation-admission-and-workspace-coordination audit.
- Add indexes, templates, local agent instructions, and validation.
- Update repository references to moved canonical documents.

## Out of scope

- Adding VitePress or another documentation dependency.
- Changing product or runtime behavior.
- Rewriting non-SDLC guides.

## Implementation plan

1. Inventory the existing corpus and preserve architecture IDs.
2. Create the canonical structure and shared conventions.
3. Move and normalize documents without changing their substantive decisions.
4. Repair links, indexes, and agent workflow references.
5. Add and run dependency-free consistency validation.

## Affected areas

- `docs/`
- `AGENTS.md`
- `.agents/skills/seqlane-adr-delivery/SKILL.md`
- Documentation path assertions
- Root package scripts and CI validation workflow

## Verification

- `pnpm docs:validate`
- `pnpm test:mapping`
- Scoped tests for changed path assertions
- Repository lint, typecheck, test, and format checks

## Completion criteria

All `spec.sdlc-documentation-system` acceptance criteria pass and no old canonical copy remains.

## Outcome

The existing corpus now has one type-based canonical location. Metadata,
statuses, legacy references, indexes, agent instructions, and repository paths
are normalized. A dependency-free validator runs locally and in CI.

## Traceability

- [spec.sdlc-documentation-system: SDLC documentation system](../specs/2026-09-03-sdlc-documentation-system.md)
