# Workflows

Each directory contains one portable workflow with a default `workflow.ts`
entrypoint and a local README that defines its contract. Run a workflow from
the repository root:

```sh
seqlane run workflows/minimal-example/workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --adapter opencode
```

Directories ending in `-example` demonstrate workflow authoring. The other
directories hold repository workflows. They are workspace code, not published
npm packages.

A workflow becomes an Nx project only when it owns a build, test, lint, or
smoke-check target.

Consumer-specific concerns stay with the consumer. The code-review Action owns
GitHub event handling, checkouts, publication, and lifecycle. The portable
review graph is `workflows/code-review/workflow.ts`.

See [AGENTS.md](./AGENTS.md) for local workflow conventions.

## Workflow index

- [all-features example](./all-features-example/README.md)
- [code review](./code-review/README.md)
- [local Git status example](./local-git-status-example/README.md)
- [local-only example](./local-only-example/README.md)
- [minimal example](./minimal-example/README.md)
- [nested example](./nested-example/README.md)
- [read context](./read-context/README.md)
- [resolve merge conflicts](./resolve-merge-conflicts/README.md)
- [until example](./until-example/README.md)

## Local operation

Workflow files are local Node.js code. Run only files you trust. The CLI loads
a module default export; use `path/to/workflow.ts#namedExport` only for an
intentional named export. Node 24 runs erasable TypeScript syntax directly.

Workflows that need an agent require `--adapter opencode` or `--adapter codex`.
The OpenCode adapter starts and owns its loopback service for the run.

Use `--workspace "$PWD"` only when a workflow needs repository files or a
shell task. Deterministic examples do not need a runtime profile.

## Code-review operation

`.github/workflows/seqlane-code-review.yml` runs the portable review graph for
eligible non-draft pull requests. Set `OPENAI_API_KEY` as an Actions secret;
without it, the workflow reports a successful skip. Automatic runs use the
trusted base workflow and source checkout, while the pull-request head is a
separate review target. A manual run is only for trusted-branch testing:

```sh
gh workflow run "Seqlane code review" --ref my-review-branch \
  -f pull_request_number=123
```

The Action owns GitHub event admission, concurrency, credentials, checkouts,
and final publication. Review tasks receive bounded Git evidence and
workspace-relative read access only: they do not run shell commands, package
managers, tests, or builds. The runtime blocks environment files and paths
outside the review workspace. Modified or new repository skills are excluded;
only unchanged base skills are staged. The publisher writes one marked bot
comment, rechecks that the pull request head is current before publishing, and
retains the validated review state and bounded run metrics there.

## Merge-conflict operation

`.github/workflows/seqlane-resolve-merge-conflicts.yml` is maintainer-dispatched
from the default branch. It accepts a same-repository pull request and a
required `rebase` or `merge` strategy. Configure `OPENAI_API_KEY` and a
dedicated `SEQLANE_RESOLVER_TOKEN` with `Contents: write` and `Workflows: write`.

The resolver receives only declared conflict files in a fresh non-Git staging
workspace. It cannot use shell commands, external paths, or project runtime
configuration. Before push, the Action rejects unexpected files, unresolved or
staged conflict markers, and whitespace errors. Rebases use the captured head
in `--force-with-lease`, so a stale remote head cannot be overwritten.
