---
id: task.publish-versioned-pull-request-review-comments
title: Publish Versioned Pull Request Review Comments
status: in-progress
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

Implementation is in progress.

## Traceability

- Contract: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Source proposal: [Seqlane review template](https://github.com/marcolink/seqlane/issues/45)
