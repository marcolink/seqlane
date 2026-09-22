# Releasing npm packages

Seqlane uses one fixed Nx release group. The `release:npm` project tag selects
its members. `seqlane` and `@seqlane/core` are the supported public APIs. The
other group members are public registry dependencies.

## Release flow

After the repository is public, every push to `main` starts
`.github/workflows/publish.yml`. The workflow uses Conventional Commits to
determine the next fixed version. For versions below `1.0.0`, `feat` and `fix`
commits that affect the release group produce a patch release. A breaking
change produces a minor release. Other commits do not create a release.

The workflow verifies the release group, then runs the complete Nx release.
Nx updates all package versions, resolves internal `workspace:*` dependencies,
updates the changelog, creates and pushes the release commit and `v<version>`
tag, creates the GitHub release, and publishes all eight packages.

The first eligible commit creates `0.0.1`. Later versions derive from commits
since the latest `v<version>` tag. GitHub Actions must have permission to write
repository contents and push the generated release commit to `main`.

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

The first release uses the `NPM_TOKEN` repository secret. After all eight
packages exist on npm, configure a trusted GitHub Actions publisher for each
package. Use repository `marcolink/seqlane` and workflow `publish.yml`. Verify
an OIDC release before restricting or removing token access.

The pull request that prepares a release does not publish packages.
