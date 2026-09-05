---
id: task.publish-versioned-pull-request-review-comments
title: Publish Versioned Pull Request Review Comments
status: completed
owners:
  - core
created: 2026-09-05
updated: 2026-09-05
upstream:
  - spec.versioned-pull-request-review-comments
supersedes: []
---

# Publish Versioned Pull Request Review Comments

## Objective

Publish a concise review comment and preserve validated lifecycle state for the
next pull-request review.

## Upstream requirements

Implement all requirements in
[spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md).

## Scope

- Add pull-request identity and v3 review-state schemas.
- Add a current-head task that evaluates retained findings and fix claims.
- Assign stable finding identifiers in the local finalizer.
- Compute lifecycle status, verdict, counts, delta, and limitations locally.
- Publish the human projection and a collapsed machine-state block.
- Validate bot ownership and live pull-request state before publication.
- Keep v1 and v2 snapshot compatibility during migration.
- Add contract, transition, publisher, and malformed-input tests.
- Update the pull-request review documentation.

## Out of scope

- Extract the complete review example into multiple modules.
- Execute pull-request code or repository checks in review tasks.
- Store full patches or credentials in review comments.
- Change public package contracts or executor boundaries.

## Implementation plan

1. Add the v3 state, lifecycle, identifier, and verification schemas.
2. Add the historical-finding verification task before the three review lanes.
3. Make the local finalizer assign identifiers and lifecycle transitions.
4. Make the publisher render the new comment and bounded state block.
5. Add live-head and trusted-comment checks before each comment write.
6. Add compatibility tests and update the example documentation.
7. Run local checks and the branch workflow against the pull request.

## Affected areas

- `examples/pr-code-review.ts`
- `apps/seqlane-cli/src/pr-code-review-example.spec.ts`
- `.github/workflows/seqlane-code-review.yml`
- `examples/README.md`
- `docs/sdlc/specs`
- `docs/sdlc/tasks`

## Verification

- Run `pnpm run test:mapping`.
- Run the focused `seqlane-cli` tests.
- Run the complete test suite and TypeScript build.
- Run Prettier and workflow YAML validation.
- Run `pnpm docs:index` and `pnpm docs:validate`.
- Execute the publisher block with representative v3 state.
- Run the branch workflow and inspect its authoritative comment.

## Completion criteria

- The v3 state passes strict validation and bounded decompression.
- The publisher owns new stable identifiers and never reuses an index.
- The lifecycle transitions match the active specification.
- A fix claim requires a current-head verification result.
- The publisher rejects untrusted comments and stale pull-request heads.
- The human projection matches issue 45 and keeps limitations visible.
- Legacy snapshot tests, local checks, and the branch workflow pass.

## Outcome

The review workflow now publishes one concise comment with a strict, bounded
version 3 state block. A history task verifies retained findings before the
three specialist lanes run. The local finalizer owns stable finding IDs,
lifecycle transitions, human dispositions, limitations, and the final verdict.

The publisher updates only a trusted GitHub Actions bot comment. It checks the
live pull-request head before each write. The visible projection shows at most
20 findings and 10 verification entries. The state retains the complete
bounded finding set and run audit data. Active blockers take priority in the
visible projection. Model-controlled text is neutralized before rendering.
The reader rejects duplicate state framing and metadata identity mismatches.
The workflow passes review input through a JSON file. Resolved fixes require
fresh current-head proof, and removed dispositions reopen stale resolved state.
Edited comments are eligible only when their current or previous body contains
a recognized review command.
Run identity prevents stale same-head publication, and duplicate temporary IDs
collapse before stable ID allocation. Per-pull-request workflow serialization
prevents concurrent comment creation or update.
Legacy IDs also deduplicate during migration. Command lines survive comment
body truncation. One aggregate budget keeps the latest command for each finding
and authorization class. State compaction is visible in both report layers.
The human projection includes command help, label emojis, and plain Markdown
sections for required changes.

Legacy version 1 and version 2 reports migrate to stable version 3 IDs. Tests
cover malformed state, ID allocation, disposition overflow, current-head fix
verification, stale metadata, truncation continuity, command-level Git output
bounds, and lifecycle transitions. The branch workflow restored version 3
state, kept existing IDs, compared consecutive reviewed commits, and published
the updated comment successfully.

## Traceability

- Contract: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Source proposal: [Seqlane review template](https://github.com/marcolink/seqlane/issues/45)
- Delivery: [pull request 44](https://github.com/marcolink/seqlane/pull/44)
- Proof: [GitHub Actions run 33966564431](https://github.com/marcolink/seqlane/actions/runs/33966564431)
