# GitHub Action Instructions

These instructions apply to all projects under `actions/`.

## Architecture

- Each action lives under `actions/<name>` and contains its own `action.yml`.
- Keep `src/main.ts` limited to GitHub Actions input/output, context, logging, and failure handling.
- Put reusable implementation in an Action-specific private `libs/` package when the behavior is larger than the entrypoint. Keep it separate from Seqlane application libraries. Do not create a generic Action support package for one Action.
- Do not make application logic depend directly on `@actions/core` or GitHub event globals.
- Use `@actions/core` and `@actions/github` in the entrypoint adapter. Do not add `@octokit/octokit.js` beside `@actions/github` without a documented reason.
- Keep `@actions/artifact`, `@actions/cache`, and `@actions/tool-cache` out of an Action bundle unless its public contract requires them.
- Use `node24` for JavaScript action entrypoints unless compatibility requirements explicitly require another supported runtime.

## Packaging

- Bundle each action and its runtime dependencies into a self-contained `dist/main.js`.
- Do not require dependency installation in the consuming workflow.
- Commit generated action bundles.
- A source change is incomplete until the corresponding bundle has been rebuilt and verified.
- Bundle drift is currently accepted by the blocking CI and push checks; use the verifier manually when validating an Action change.
- Do not edit bundled files manually.

## Paths

- Use `GITHUB_WORKSPACE` for the consumer repository.
- Use `GITHUB_ACTION_PATH` for assets shipped with the action.
- Do not assume `process.cwd()` is the action directory.

## Inputs and outputs

- Declare every public input and output in `action.yml`.
- Validate inputs at the entrypoint before calling implementation code.
- Keep commit and push behavior independently configurable.
- Do not push implicitly when the action was only asked to inspect or modify files.

## Git operations

- Execute Git with argument arrays rather than interpolated shell commands.
- Treat expected Git states, such as merge conflicts or an empty commit, as modeled outcomes.
- Use repository-local Git configuration for commit identity.
- Use the Git CLI for working-tree, merge, rebase, commit, and push operations.
- Use Octokit for GitHub platform operations such as PR comments, checks, labels, and metadata.

## Verification

Before completing an action change:

1. Run its unit tests.
2. Run Git integration tests against temporary repositories.
3. Bundle the action.
4. Verify the committed bundle matches the source.
5. Run the action through `uses: ./actions/<name>` on a GitHub-hosted runner when behavior or metadata changed.
