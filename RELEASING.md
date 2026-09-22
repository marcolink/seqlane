# Releasing npm packages

Seqlane uses one fixed Nx release group. The `release:npm` project tag selects
its members. `seqlane` and `@seqlane/core` are the supported public APIs. The
other group members are public registry dependencies.

## Prepare a release

Use Node.js 24, pnpm 10.33.0, and npm 11.5.1 or later. Start from an updated
`main` branch with a clean worktree.

Run the repository checks. Then preview the version operation:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm exec nx release <version> --dry-run --skip-publish
```

Run `pnpm exec nx release <version> --skip-publish` to update the fixed package
version, resolve internal `workspace:*` dependencies to that exact version,
update the changelog, commit, and create the `v<version>` tag. Review the
result, then run `pnpm release:publish:dry-run` from the versioned commit.

## Publish

Push the release commit to `main` before pushing its `v<version>` tag. The tag
starts `.github/workflows/publish.yml`. The workflow requires a public
repository and a tagged commit reachable from `main`. It builds and tests the
release group before `nx release publish` calls npm.

The first release uses the `NPM_TOKEN` repository secret. After all eight
packages exist on npm, configure a trusted GitHub Actions publisher for each
package. Use repository `marcolink/seqlane` and workflow `publish.yml`. Verify
an OIDC release before restricting or removing token access.

The pull request that prepares a release does not publish packages.
