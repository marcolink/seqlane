# Release channels

`main` publishes stable versions under npm's `latest` tag. `next` publishes
`X.Y.Z-beta.N` versions under the `next` tag. All eight release packages use
the same version and channel. GitHub marks beta releases as prereleases.

The `next` channel becomes available after its first beta publication.

```sh
npm install seqlane@next @seqlane/core@next
```

To return to stable packages:

```sh
npm install seqlane@latest @seqlane/core@latest
```

## Publish a beta

1. Merge release support into `main`.
2. Create `next` from that revision.
3. Apply the required CI checks to `next`.
4. Target migration pull requests at `next`.
5. Preserve commit history during the merge.

An eligible push starts the existing CI quality gate and release workflow.
Other branches, pull requests, and manual CI runs cannot publish. One shared
lock serializes publication across both release branches.

Nx derives eligibility from Conventional Commits that affect release packages.
The first beta reserves at least the next minor version. For example,
`0.2.1` starts `0.3.0-beta.0`. Later eligible commits increment the beta
number. Documentation-only commits do not publish. Stable hotfixes retain the
existing pre-1.0 rules: features and fixes increment the patch version, and
breaking changes increment the minor version.

The workflow retains `ci.yml` as the trusted-publisher caller. It uses the
existing `publish.yml`, public package set, npm provenance, and OIDC identity.
No npm token is required. Verify the trusted-publisher configuration for all
eight packages before the first beta publish.

After publication, inspect the workflow summary and all eight registry
versions. Verify that each `next` tag points to the beta. Every `latest` tag
must retain its preceding stable value.

## Retry a failed release

Rerun the original workflow. Keep its branch and revision unchanged. Recovery
verifies the remote Git tag and recalculates the version at that revision.
It restores runner-local manifests and release notes. It skips package
versions that already exist and publishes the missing versions.

Recovery preserves the original channel after the branch advances. A missing
version permits publication only after an explicit registry `E404` response.
Authentication errors, invalid responses, and network errors stop publication.
If publication moves its channel tag backward, the missing version cannot publish.

## Promote an accepted beta

1. Merge `next` into `main` with history intact.
2. Wait for the stable release workflow.
3. Verify the stable versions and `latest` tags for all eight packages.
4. Install the stable packages outside the checkout.
5. Synchronize `main` into `next` before another beta series.

Promotion publishes fresh stable versions at the beta target. For example,
`0.3.0-beta.1` becomes `0.3.0`. Moving a dist-tag to a beta package does not
produce a stable release. Stable notes include changes from the stable
baseline, including the migration.

## Validate publishing changes

Run the mapping check before release tests:

```sh
pnpm test:mapping
pnpm test:tooling
pnpm docs:validate
```

The integration test uses real Nx versioning, local Git repositories, package
archives, and npm dry-run publication. It covers repeated betas, an independent
stable hotfix, stable promotion, and recovery after branch advancement.
GitHub-hosted runs establish OIDC and registry publication evidence.
