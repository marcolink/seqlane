---
id: spec.sdlc-documentation-system
title: SDLC documentation system
status: active
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - prd.seqlane
supersedes: []
---

# SDLC documentation system

## Summary

Seqlane maintains its software-development lifecycle documents as one canonical
Markdown corpus in `docs/sdlc/`.

## Goals

- Give each SDLC document a predictable location and stable identity.
- Trace business intent through product, architecture, contracts, and work.
- Define authority when documents disagree.
- Keep each document type focused on its normative responsibility.
- Keep the corpus readable in GitHub, raw Markdown, documentation renderers,
  and coding-agent context.
- Preserve historical decisions without presenting superseded work as current.

## Non-goals

This specification does not define product or runtime behavior, introduce a
project-management service, synchronize an external issue tracker, make tasks
executable workflows, reorganize non-SDLC guides, or require renderer-specific
components.

## Terminology

| Type | Responsibility |
| --- | --- |
| BRD | Business problem, outcomes, constraints, and success measures |
| PRD | Product behavior, scope, requirements, and user-visible acceptance |
| RFC | Architecture, alternatives, boundaries, and trade-offs |
| ADR | One architecture decision, its context, and consequences |
| SPEC | Exact interfaces, semantics, edge cases, and technical acceptance |
| TASK | Bounded implementation scope, verification, and outcome |

ADRs are decision records, not another lifecycle level. Milestones belong in
the relevant PRD unless a separate non-normative roadmap is useful.

## Requirements

### C01: Canonical layout

The canonical root is `docs/sdlc/`. Documents are grouped in lowercase `brd`,
`prd`, `rfcs`, `adrs`, `specs`, and `tasks` directories. Tasks are not nested
under specs, and specs are not nested under RFCs.

### Stable identity

Document IDs use `<type>.<lowercase-kebab-title>`. An ID is unique within the
corpus and remains unchanged after title, status, or filename changes. Filenames
use `<YYYY-MM-DD>-<lowercase-kebab-title>.md`, with the `created` date as the
filename date.

### Metadata

Each non-index document contains `id`, `title`, `status`, a non-empty `owners`
list, ISO `created` and `updated` dates, and `upstream` and `supersedes` lists.
Relationships contain stable metadata IDs, not numeric IDs or filename patterns.

### Traceability

PRDs, RFCs, specs, and tasks contain a `Traceability` section with Markdown
links to their meaningful upstream documents or clauses. Metadata relationships
and body links must identify the same canonical documents.

### C05: Authority and history

The authority rules in `docs/sdlc/index.md` govern conflicts. Supersession is
explicit. Rejected and superseded documents remain at their canonical paths and
are distinguishable by status.

### C06: Discovery

Each type has a checked-in `index.md` with every document's ID, title, status,
and owners. `docs/index.md` links to this corpus without duplicating it.

### C07: Agent workflow

`docs/sdlc/AGENTS.md` directs agents to current tasks and specs and prevents
tasks from redefining upstream contracts. The root agent guide routes SDLC work
to those local instructions.

### C08: Markdown portability

Canonical documents use standard Markdown and relative links. Essential content
does not depend on a documentation renderer or agent-specific copy.

### C09: Validation

`pnpm docs:validate` reports all detected metadata, location, ID, status, date,
reference, index, and relative SDLC link errors in one run. The validator uses
Node.js standard-library APIs and adds no documentation dependency.

## Detailed contracts

Allowed statuses and the authority model are defined in
[`docs/sdlc/index.md`](../index.md). Templates define the minimum sections for
each type. Unknown metadata fields require an update to that shared contract.

When a title changes, the filename may change, but the metadata ID must not
change. Update links and metadata references in the same change. Keep the
filename date equal to `created`; `updated` does not rename the file. A document
may skip an absent lifecycle level; it must not create a placeholder only to
complete the chain.

## Failure and edge cases

- Duplicate IDs and broken links are invalid even if the conflicting document
  is superseded.
- A document cannot supersede itself.
- The replacement document owns the `supersedes` relationship.
- Legacy numeric IDs can remain only in migration history, not as canonical
  metadata IDs or relationships.
- Git history, not a duplicate file, preserves obsolete source locations.

## Migration

The migration classifies documents by responsibility and assigns source dates.
It renames files to date-slug paths and replaces numeric IDs with stable
metadata IDs. It updates links and indexes. It merges MVP scope into the PRD.
It merges the invocation-admission audit into its ADR. Git history preserves
old paths.

## Verification

Run `pnpm docs:validate`, `pnpm test:mapping`, and the repository checks affected
by repaired documentation path assertions.

## Acceptance criteria

- Each existing SDLC document has one canonical location.
- Every canonical document has valid metadata and an indexed stable ID.
- Canonical filenames and headings contain no numeric document IDs.
- Traceability and relative links resolve.
- Root and local agent instructions route work to the canonical corpus.
- No obsolete duplicate SDLC files remain outside `docs/sdlc/`.
- Validation succeeds without a new dependency.

## Traceability

- [prd.seqlane: Seqlane](../prd/2026-09-02-seqlane.md)
