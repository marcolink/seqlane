# Seqlane SDLC documents

This directory is the canonical source for Seqlane software-development
lifecycle documents. The lifecycle is:

```text
BRD -> PRD -> RFC -> SPEC -> TASK
```

The arrows describe traceability and authority, not directory nesting. ADRs
record individual architecture decisions and can be referenced by RFCs, specs,
and tasks.

## Document types

- [Business requirements](./brd/index.md)
- [Product requirements](./prd/index.md)
- [Requests for comments](./rfcs/index.md)
- [Architecture decision records](./adrs/index.md)
- [Technical specifications](./specs/index.md)
- [Implementation tasks](./tasks/index.md)
- [Document templates](./templates/)

## Next implementation deliverable

[Publish Seqlane Packages](./tasks/2026-09-21-publish-seqlane-packages.md) is
the next agreed deliverable. It implements the accepted
[public release decision](./adrs/2026-09-21-public-npm-release.md) and active
[distribution contract](./specs/2026-09-21-public-npm-distribution.md). The
pull request prepares the release. It does not publish packages.

## Authority

- An accepted BRD defines current business intent.
- An accepted PRD defines current product requirements and scope.
- Accepted RFCs and ADRs record architectural rationale and decisions.
- An active spec defines the current implementation contract.
- A task defines execution work. It does not redefine requirements or contracts.
- These lifecycle states do not prove implementation delivery. An accepted ADR
  is not the same as an implemented ADR. An active spec is not the same as an
  implemented spec. A completed task is a historical or document-revision
  claim, not a default-branch delivery claim.
- If code and an active spec disagree, fix the implementation or explicitly
  change the spec.
- If a spec changes an accepted architecture decision, amend or supersede the
  RFC or ADR in the same change.
- A newer document does not override an older document unless supersession is
  explicit.

## Delivery evidence

Document status and type indexes support discovery and history. They are not a
single source of truth for implementation delivery. To claim delivery, inspect
the current target-branch source, tests, and configuration. Also require a
reachable commit or a merged pull request whose resulting commit is reachable
from that target branch. A local branch, disconnected worktree, task or spec
status, index row, or pull-request label alone is insufficient. A merged pull
request whose commit is not reachable from the target branch does not establish
current delivery.

## Naming and metadata

Document names use `<YYYY-MM-DD>-<lowercase-kebab-title>.md`. The date is the
document's `created` date. The parent directory defines the document type.

Every document has a stable, non-numeric metadata ID such as
`spec.semantic-validation-gates` or `task.integration-and-documentation`.
The ID does not change when the title, status, or filename changes.

Every document has `id`, `title`, `status`, `owners`, `created`, `updated`,
`upstream`, and `supersedes` frontmatter. Relationship fields contain stable
metadata IDs. Body-level `Traceability` sections link to the exact related
documents or clauses.

Allowed statuses are:

| Type | Statuses |
| --- | --- |
| BRD | `draft`, `review`, `accepted`, `superseded` |
| PRD | `draft`, `review`, `accepted`, `superseded` |
| RFC | `proposed`, `accepted`, `rejected`, `superseded` |
| ADR | `proposed`, `accepted`, `rejected`, `superseded` |
| SPEC | `draft`, `active`, `superseded` |
| TASK | `planned`, `in-progress`, `blocked`, `completed`, `cancelled` |

Superseded and rejected documents remain at their original canonical path. A
document can be retired without a replacement only when its body has a clear
status note that explains the retirement and points readers to current
examples or references where applicable.

## Create a document

1. Read [the local agent instructions](./AGENTS.md).
2. Copy the matching file from `templates/` and remove its guidance comments.
3. Set a stable metadata ID with the document type and title slug.
4. Set `created` from the source document or the current date.
5. Name the file with the `created` date and a lowercase kebab-case title slug.
6. Link the nearest meaningful upstream documents in metadata and in the
   `Traceability` section. Do not infer relationships from names.
7. Add the document to its type index.
8. Run `pnpm docs:index` and `pnpm docs:validate`.

## Find the source of truth

Start with the assigned task or active spec. Follow upstream links only as far
as needed to understand product intent and architecture constraints. Use the
type indexes to find documents, not to prove implementation delivery. Compare
delivery claims with the current target-branch source, tests, configuration,
and reachable Git history.
