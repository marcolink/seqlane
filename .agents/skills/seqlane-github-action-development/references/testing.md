# Testing GitHub Actions

## Test layers

1. Unit-test pure TypeScript behavior.
2. Test Git behavior against temporary real repositories.
3. Test the action adapter using fixture event payloads.
4. Execute the local action with `uses: ./actions/<name>`.
5. Reserve remote push tests for trusted, disposable branches or repositories.

Do not mock Git when testing Git semantics.

## Temporary repository integration

Create a fresh temporary repository for each Git integration test. Configure
the Git identity in that repository. Run Git with argument arrays and the
repository as its working directory.

Assert repository state instead of Git log wording. Check the exit code, HEAD,
porcelain status, index entries, staged diff, and remote ref as applicable.

For merge and rebase behavior, use the conflict scenarios in
`seqlane-git-automation`. Include only the scenarios that the action supports.

Keep action adapters thin. Pass parsed inputs and GitHub context values to
ordinary TypeScript functions. Unit-test those functions without an Actions
Toolkit environment.

## Local wrapper execution

No local action-wrapper simulator is approved in this workspace. Snyk does not
provide a package record for `@github/local-action`. Do not install or run it
until a dependency security review confirms a safe package source and version.

After approval, use fixture environment variables and event payloads to test
input parsing, action outputs, logging, annotations, and failure handling.
Treat a local simulator as supplemental. It cannot reproduce GitHub token
permissions, checkout behavior, networking, runner images, or all event state.

## Required Git scenarios

Select the scenarios relevant to the changed behavior:

- clean repository;
- changed tracked file;
- new untracked file;
- empty commit;
- detached HEAD;
- shallow clone;
- missing remote;
- clean merge;
- content conflict;
- modify/delete conflict;
- rename conflict;
- upstream changes before push.

## Bundle verification

Rebuild all affected action bundles and run:

```bash
git diff --exit-code -- dist/ actions/*/dist/
```
