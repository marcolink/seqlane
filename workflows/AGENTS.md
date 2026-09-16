# Workflow conventions

`workflows/` owns portable Seqlane workflow definitions. A workflow is
executed with `seqlane run workflows/<name>/workflow.ts`; it is not an npm
package published by this repository.

- Give every workflow its own directory and default `workflow.ts` entrypoint.
- Use one globally unique, kebab-case ID for each workflow and task. Do not
  encode a filesystem path, caller, or hierarchy in an ID.
- `.task()` keys are local graph labels. They need only be unique within the
  defining workflow.
- Keep consumer environment adaptation in the consumer. GitHub event parsing,
  checkouts, concurrency, publication, credentials, and Action lifecycle stay
  under `actions/` or their supporting consumer library.
- Mark retained examples in their directory names with `-example` and the Nx
  `workflow-kind:example` tag.
- Do not add workflow unit tests by default. Test reusable task/library logic;
  add a workflow test only for an observable regression or integration seam.
- Add an Nx `project.json` only when the workflow owns a build, test, lint, or
  smoke-check target. Add a `build` target only when compilation or bundling
  requires it. Do not add an Nx `run` target: use the Seqlane CLI.
