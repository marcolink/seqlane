---
id: task.next-beta-releases
title: Release Effect Migration Betas from next
status: in-progress
owners:
  - core
created: 2026-10-23
updated: 2026-10-23
upstream:
  - spec.public-npm-distribution
supersedes: []
---

# Release Effect Migration Betas from next

## Objective

Release the Effect migration through an opt-in beta channel. Keep stable
releases on `main` and beta releases on `next`.

Before:

```text
feat/effect-v4-migration -> main -> v0.2.x -> npm latest
```

After, with the proposed first beta target:

```text
feat/effect-v4-migration -> next -> v0.3.0-beta.0 -> npm next
                             -> v0.3.0-beta.1 -> npm next
next -> main                   -> v0.3.0        -> npm latest
```

Users select the beta explicitly:

```sh
npm install seqlane@next @seqlane/core@next
```

## Upstream requirements

Implement [release channels](../specs/2026-09-21-public-npm-distribution.md#requirement-release-channels)
and retain the existing package, provenance, and recovery requirements.

## Scope

- Branch-aware CI, version selection, release notes, publication, and retries.
- The existing eight-package fixed release group and trusted publishing path.
- Beta install instructions and a proven stable promotion path.

## Out of scope

- Effect implementation or changes to its runtime contracts.
- Additional release packages, package managers, or versioning frameworks.
- Public documentation-site deployment from `next`.
- Remote branch creation, PR retargeting, merges, or publication during planning.

## Documentation impact

Classification: contract change

- PRD: no change
- RFC: no change
- SPEC: update `spec.public-npm-distribution` with channel and promotion contracts
- TASK: create `task.next-beta-releases` for release delivery
- ADR required: no

### Rationale

The active distribution spec owns publication. The existing ADR retains fixed
versions, Nx ownership, workspace references, and the current pack/publish split.
This plan adds a release channel without a runtime architecture decision.

### Required work

1. Extend the distribution spec with stable and beta channel rules.
2. Record this bounded task and its delivery gates.
3. Implement and prove release support before routing the migration into it.

### Open questions

None blocks implementation. The proposed initial target is `0.3.0` from the
current stable `0.2.1`. If stable advances, reassess the target before first publication.

## Implementation plan

### Tracer bullet: one complete beta dry run

- **Outcome:** all eight packages reach npm dry-run publication as `0.3.0-beta.0` under `next`.
- **Path:** eligible `next` commit -> CI quality -> exact-revision build -> Nx version/changelog -> archives -> npm dry run.
- **Risk:** Nx version selection, custom publish arguments, and recovery currently assume one stable channel.
- **Evidence:** use real Nx 22.7.1, pnpm packing, and npm dry runs in an isolated Git fixture.
- **Excluded:** live publication, migration merge, stable promotion, and extra packages.

Start `chore/next-beta-releases` from current `main`. This change is
independently mergeable and does not depend on Effect code. Keep Nx as the
versioning authority. Prove its pinned APIs before adding custom version logic.

Extend `.github/workflows/ci.yml` to admit both branches after the same quality
gate. Reuse `.github/workflows/publish.yml` and its OIDC caller identity.
Add one shared publish lock with cancellation disabled.

Make `scripts/prepare-release.mjs` select an allowlisted branch and channel.
Carry that selection through version calculation, Git tags, GitHub releases,
output metadata, and recovery. Mark beta GitHub releases as prereleases.
Explicitly exclude them from latest-release selection.

Update the custom publish target in `nx.json` to pass the channel to npm.
`forwardAllArgs: false` currently discards forwarded CLI arguments.
Do not rely only on `nx release publish --tag next`.

Before:

```sh
npm publish "$archive" --access public --dry-run="$NX_DRY_RUN"
```

After, with a channel already validated against branch and version:

```sh
npm publish "$archive" --access public --tag "$dist_tag" --dry-run="$NX_DRY_RUN"
```

### Next slice: repeat beta, stable hotfix, and recovery

Prove `0.3.0-beta.0` -> `0.3.0-beta.1` through the same path. Prove that a
concurrent `main` fix produces `0.2.2` under `latest`. A no-impact commit must
produce no release. Keep source `workspace:*` references and exact archive dependencies.

Add channel-aware tag discovery and changelog baselines. Cover retries after
tag creation, partial publication, and branch advancement. Include stable and
beta tags on one commit. Reject wrong-channel tags and ambiguous state.
An older retry must not move a registry tag backward.

### Next slice: publish the migration beta

Merge release support into `main` first. Create `next` from that updated
revision. Apply equivalent required quality checks to `next`.

Retarget [migration PR #180](https://github.com/marcolink/seqlane/pull/180) from
`main` to `next`. Integrate release support into the migration branch.
Rerun CI on the combined head. Preserve migration history during the merge.

Verify trusted publishing for all eight packages through the existing caller.
The first eligible migration push publishes the proposed `0.3.0-beta.0`.
Read back all eight versions, provenance, and `next` tags. Verify that every
`latest` tag retains its preceding stable value. Install the registry beta
outside the checkout. Run the compiled CLI and one deterministic workflow.

### Next slice: prove stable promotion

In an isolated fixture, merge `next` into `main` with history intact.
Prove a fresh stable release at the reserved target. Verify that release
notes include the migration and archives have exact stable internal dependencies.
Run the compiled CLI and a deterministic workflow from the installed archives.

After beta acceptance, use this path for live stable promotion. Synchronize
`main` into `next` afterward. Select a higher target for another beta series.
For beta consumers, rollback means installing the preceding stable release explicitly.

## Affected areas

`.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `nx.json`,
`scripts/prepare-release.mjs`, release verification/tests, and installation
documentation. Keep dependency and package-set changes outside this task.

## Verification

Run test mapping before focused release tooling tests. Use isolated Git
repositories and a controlled registry for mutation and retry cases. Run real
Nx version/changelog operations and npm publish dry runs for the first tracer.
Run `actionlint`, archive verification, documentation checks, and external
install smoke tests. GitHub-hosted runs prove OIDC and remote publication.

## Completion criteria

- The first tracer and all channel/recovery scenarios pass.
- The migration publishes from `next` with complete registry readback.
- Every beta leaves the stable channel unchanged.
- A fixture proves stable promotion before this task becomes completed.

## Outcome

Publishing support is implemented on `chore/next-beta-releases`, based on
`main` at `6512cf84fe011831b455704f161c8de2cf8d7bb2`. It is independently
mergeable before the Effect migration.

CI admits both release branches after the same quality gate. One shared lock
serializes publication. Nx owns eligibility, versioning, changelogs, tags, and
publish order. A series reserves at least a minor target through native Nx
versioning. The custom target retains native pnpm packing and npm publication.
A registry preflight validates channel/version agreement and refuses failed
lookups or backward tag moves.

The real Nx fixture proves first and repeated betas, no-impact commits, a
stable hotfix, promotion, and recovery after branch advancement. It also
preserves stable and beta tags on one revision. All 51 tooling tests pass.
All eight release packages build. Their `0.3.0-beta.0` archives pass
verification and real npm publish dry runs. An external project installs all
eight archives and runs the compiled CLI with a deterministic workflow.
The workflow preserves false-valued output. Public export tests pass for
core, protocol, and runtime: 38 assertions across three files.

Remote branch creation, migration PR retargeting, and live beta publication
remain separate work after the publishing PR. This task remains in progress.

## Delivery state

Verified on 2026-10-23: `main` is `6512cf84fe011831b455704f161c8de2cf8d7bb2`.
`seqlane@latest` is `0.2.1`. npm has no `next` dist-tag. No remote `next`
branch exists. Draft PR #180 targets `main` at migration head
`227935795bceb6eee46504262f2bb4e398611160`.

The verified `main` and migration heads retain the stable-only release
script and custom publish target. Publishing support is in PR #182, pending
CI validation and merge. Existing Effect documents on this checkout
describe the superseded runtime and do not establish migration delivery.

## Traceability

- [spec.public-npm-distribution](../specs/2026-09-21-public-npm-distribution.md)
- [adr.preserve-workspace-release-references](../adrs/2026-09-22-preserve-workspace-release-references.md)
- [task.publish-seqlane-packages](./2026-09-21-publish-seqlane-packages.md)
- [Effect migration PR #180](https://github.com/marcolink/seqlane/pull/180)
- [Beta publishing PR #182](https://github.com/marcolink/seqlane/pull/182)
- [Effect execution contract on the migration branch](https://github.com/marcolink/seqlane/blob/227935795bceb6eee46504262f2bb4e398611160/docs/sdlc/specs/2026-10-21-effect-v4-execution-and-operations.md)
- [npm publish tag behavior](https://docs.npmjs.com/cli/v11/commands/npm-publish/#tag)
