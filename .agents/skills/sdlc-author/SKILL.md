---
name: sdlc-author
description: Create or substantially revise canonical Seqlane SDLC documents with correct ownership, metadata, links, and indexes.
---

# SDLC author

Create or revise BRDs, PRDs, RFCs, ADRs, specs, and tasks in the canonical
`docs/sdlc/` corpus.

## Before writing

1. Read `docs/sdlc/AGENTS.md` and `docs/sdlc/index.md`.
2. Search the type indexes and active documents for the concern.
3. Decide whether an existing document already owns the concern. Update it
   instead of creating a duplicate.
4. Ask one concise question when the document type or ownership is unclear.

Classify the request before selecting a template:

| Question                                                                    | Document type |
| --------------------------------------------------------------------------- | ------------- |
| What business problem, outcome, or constraint exists?                       | BRD           |
| What product behavior or user-visible requirement is needed?                | PRD           |
| What system architecture, boundary, or alternative needs discussion?        | RFC           |
| What single architecture decision must be recorded?                         | ADR           |
| What exact contract, interface, semantics, or failure behavior is required? | SPEC          |
| What bounded implementation work is needed?                                 | TASK          |

Reject responsibility overlap. A PRD must not define implementation details. An
ADR must not contain the full implementation contract. A task must not redefine
product requirements or an active spec.

## Authoring rules

- Use the matching file in `docs/sdlc/templates/`.
- Allocate an unused stable metadata ID: `brd.<slug>`, `prd.<slug>`,
  `rfc.<slug>`, `adr.<slug>`, `spec.<slug>`, or `task.<slug>`.
- Name the file `YYYY-MM-DD-<lowercase-kebab-title>.md`. Use the source
  document's creation date when migrating; otherwise use the current date.
- Keep the filename date equal to `created`. Do not change it when `updated`
  changes.
- Add valid `id`, `title`, `status`, `owners`, `created`, `updated`, `upstream`,
  and `supersedes` frontmatter.
- Put stable metadata IDs in `upstream` and `supersedes`. Do not infer links
  from filename order, title text, or numeric sequences.
- Add Markdown links to the same related documents in `Traceability`.
- Add stable requirement or decision keys when downstream references are
  expected. Use keys such as `requirement-reusable-tasks` or
  `decision-private-runtime` and link downstream references to their headings.

## Supersession

When a new document replaces an existing one:

- set the replacement document's `supersedes` metadata;
- set the replaced document's status to `superseded`;
- update links and indexes;
- keep both documents at their canonical paths.

Do not move or delete a superseded document. Delete only an exact obsolete
duplicate after confirming that no canonical content is lost.

## Finish

Update the relevant type index. Run:

```sh
pnpm docs:index
pnpm docs:validate
```

Report the selected type, stable ID, upstream links, supersession decision,
and validation result.
