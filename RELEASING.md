# Releasing npm packages

Seqlane uses one fixed Nx release group. The `release:npm` project tag selects
its members. `seqlane` and `@seqlane/core` are the supported public APIs. The
other group members are public registry dependencies.

## Release flow

Every push to `main` starts `.github/workflows/ci.yml`. After its quality job
passes, CI calls `.github/workflows/publish.yml`. This reusable workflow uses
Conventional Commits to determine the next fixed version. For versions below
`1.0.0`, `feat` and `fix` commits that affect the release group produce a patch
release. A breaking change produces a minor release. Other commits do not
create a release.

The quality job checks the triggering commit without stored credentials. The
release workflow starts only after all quality gates pass. Its read-only build
job uploads the release packages for the publish job.

The publish job checks out the same commit and does not run dependency scripts.
It stops a new release if `main` advanced after the workflow started. A retry
for a validated existing tag remains valid after `main` advances. Nx then updates all
package versions and preserves internal `workspace:*` dependencies. It also
generates the changelog in the runner, creates the `v<version>` tag and GitHub
Release, and publishes all eight packages. It does not create or push a release
commit. The bounded job summary uses the current GitHub Release body.

The Nx publish target packs each package with pnpm. pnpm converts `workspace:*`
to exact versions in each package archive. The target then publishes the
archive with npm. Source manifests keep the workspace references. Versioned
manifests exist only in the release runner and also keep `workspace:*` until
pnpm creates each archive. A retry checks npm before packing. It skips an exact
package version that already exists and publishes only missing package versions.

The first eligible commit creates `0.0.1`. Later versions derive from commits
since the latest `v<version>` tag. GitHub Actions must have permission to write
repository contents so it can push the tag and create the GitHub Release. The
workflow uses its built-in short-lived token. It does not push to `main` and
does not need a ruleset bypass actor.

If a run fails after it pushes the tag, rerunning the workflow verifies that
the remote tag points to the triggering commit and matches the version that Nx
calculates. It then restores the runner-local package versions and first-release state. Nx
regenerates the same changelog and GitHub Release before publication continues.
The workflow does not store its token in the Git remote or repository config.

## Preview locally

Use Node.js 24, pnpm 10.33.0, and npm 11.5.1 or later. Start from an updated
branch with a clean worktree. Run the repository checks, then preview without
creating a release or publishing packages:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm exec nx release --dry-run --skip-publish
```

Each package trusts repository `marcolink/seqlane` and workflow `ci.yml`. The
publish job uses npm trusted publishing through OIDC. It does not receive an
npm token. After a release succeeds without the token, select "Require
two-factor authentication and disallow bypass 2FA tokens" for all eight
packages. Then remove the `NPM_TOKEN` repository secret and revoke the npm
token.

The pull request that prepares a release does not publish packages.
