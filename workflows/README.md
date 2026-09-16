# Workflows

Each directory contains one portable workflow with a default `workflow.ts`
entrypoint. Run a workflow from the repository root:

```sh
seqlane run workflows/minimal-example/workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime opencode
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
