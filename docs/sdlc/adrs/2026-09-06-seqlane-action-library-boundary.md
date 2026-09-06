---
id: adr.seqlane-action-library-boundary
title: Use an Action-Specific Library for Merge-Conflict Resolution
status: accepted
owners:
  - core
created: 2026-09-06
updated: 2026-09-06
upstream:
  - adr.dedicated-runner-process
  - adr.executor-neutral-workflow-authoring
  - adr.autonomous-non-interactive-execution
  - adr.local-mechanical-tasks
supersedes: []
---

# Use an Action-Specific Library for Merge-Conflict Resolution

## Context

The merge-conflict resolver currently places most of its behavior in
`.github/workflows/seqlane-resolve-merge-conflicts.yml`. The workflow contains
pull-request checks, Git operations, workspace safety rules, lockfile
regeneration, OpenCode lifecycle management, Seqlane execution, and push
guards.

The repository now has a JavaScript Action structure. Each Action has a thin
entrypoint, a bundled `dist/main.js`, and reusable implementation in a private
library under `libs/`. The current
`actions/resolve-merge-conflicts/src/main.ts` is an empty foundation entrypoint.

Action support is CI and platform integration code. It is not part of the
Seqlane application. It uses private Seqlane runtime capabilities to create an
Action, but it does not extend the Seqlane authoring model, Plan IR, runner IPC,
or public runtime contracts.

The migration must reduce workflow code without weakening the trust boundary.
The workflow must not execute pull-request source as trusted Seqlane source.
The resolver must keep Git operations explicit, testable, and safe for remote
history updates.

The implementation belongs in `libs/action-merge-conflict-resolution`. The
directory must not use the `seqlane-` prefix. The library is specific to the
merge-conflict resolver and is not a general GitHub Action support package.

## Decision drivers

- Keep workflow YAML responsible for GitHub job composition.
- Keep Action input and output handling in the Action entrypoint.
- Keep domain behavior in ordinary TypeScript that can run without an Actions
  Toolkit environment.
- Keep GitHub platform access separate from Git and filesystem access.
- Use the existing OSS GitHub communication package through a resolver-scoped
  adapter.
- Keep this library specific to merge-conflict resolution.
- Keep future OpenCode and service Actions in their own Action boundaries.
- Preserve the existing merge, rebase, lockfile, agent, and push behavior.
- Bundle all Action runtime dependencies into `dist/main.js`.
- Keep Seqlane workflow authoring executor-neutral.
- Make safety rules testable with real temporary Git repositories.

## Considered options

### Keep the current workflow shell implementation

This requires no package move. It leaves the main behavior in a large YAML
file and makes Git state transitions difficult to test. It also leaves the
Action foundation unused. Rejected.

### Put all behavior in `actions/resolve-merge-conflicts/src/main.ts`

This reduces workflow size. It creates a large Action entrypoint that depends
on GitHub context and makes pure policy difficult to reuse and test. Rejected.

### Add `libs/github-action-support`

This creates a broad support package for one resolver before multiple Actions
share a stable contract. It would also become a possible home for OpenCode
and unrelated service lifecycle behavior. Rejected for this migration.

### Add `libs/action-merge-conflict-resolution`

This private package owns the merge-conflict Action application and its
contracts, policies, adapters, and tests. It uses the existing OSS GitHub
client through a narrow pull-request metadata adapter.

The package keeps resolver-specific Git, filesystem, Docker lockfile, agent,
and push behavior together. The Action entrypoint adapts GitHub inputs and
services. The workflow retains triggers, permissions, concurrency, runner
selection, and checkout steps. Chosen.

## Decision outcome

Create the private package `libs/action-merge-conflict-resolution` with the
workspace package name `@seqlane/action-merge-conflict-resolution`. The
directory name must not use the `seqlane-` prefix.

The package contains the following concerns:

- plain application contracts, validation, typed errors, and result models
- A pull-request metadata adapter backed by the existing OSS GitHub client
- Git CLI adapters for status, merge, rebase, conflict inspection, commit,
  fetch, and guarded push operations
- workspace and staged-content safety policies
- isolated lockfile regeneration and result validation
- a resolver-scoped agent port and adapter for the current OpenCode/Seqlane
  execution contract
- the conflict-resolution controller and bounded Action summary output

The package does not contain the Seqlane application itself. It must not own
workflow authoring, Plan IR, public workflow APIs, runner IPC, generic Seqlane
runtime contracts, generic GitHub client code, or generic Action lifecycle
helpers.

The package can contain the resolver-specific behavior needed to start the
agent only for agent conflicts and to regenerate lockfiles in a pinned Docker
image. It must not become a reusable OpenCode server lifecycle package. A
future `opencode-server` or service Action must own its own lifecycle. This
package can consume that Action through a narrow port if the current
conditional-start and cleanup behavior remain intact.

Use this dependency direction:

```text
workflow YAML
    -> actions/resolve-merge-conflicts/src/main.ts
        -> libs/action-merge-conflict-resolution
            -> existing OSS GitHub client, Git CLI, filesystem, Docker, and private Seqlane ports

future OpenCode or service Action
    -> its own Action-specific implementation and lifecycle boundary
```

The Action entrypoint can depend on `@actions/core` for Action input, output,
logging, and failure handling. GitHub API communication uses the existing OSS
client through the resolver adapter. The library must not depend on GitHub
event globals or Actions Toolkit objects. Seqlane application packages must
not depend on this Action-specific package.

The workflow must retain these concerns:

- `workflow_dispatch` inputs
- `contents: write` and `pull-requests: read` permissions
- per-pull-request concurrency
- runner and timeout selection
- trusted source checkout at the workflow revision
- pull-request target checkout with full history
- the bootstrap data needed before `actions/checkout` can receive a target
  revision.

The library and Action must own all remaining resolver behavior. The Action
must publish typed outputs and a bounded job summary. The Action must not
require dependency installation in the consuming workflow.

The generic Seqlane workflow definition remains separate from this Action
application. It must not import OpenCode, GitHub, or Action types.

## Dependency and tooling decision

Evaluate the listed open-source components by role. Do not treat all of them
as runtime dependencies of the resolver.

- [`@actions/core`](https://github.com/actions/toolkit/tree/main/packages/core)
  is the Action entrypoint boundary for inputs, outputs, summaries, secret
  masking, annotations, and failure status.
- [`@actions/github`](https://github.com/actions/toolkit/tree/main/packages/github)
  is the selected GitHub client adapter for this Action. It creates the
  authenticated Octokit client and reads Action context. The resolver library
  receives a narrow pull-request metadata port.
- [`@actions/exec`](https://github.com/actions/toolkit/tree/main/packages/exec)
  is optional for foreground commands. If used, adapters must pass command and
  argument arrays, explicit working directories, and controlled environments.
  Long-lived services use a spawn-based lifecycle adapter.
- [`@octokit/octokit.js`](https://github.com/octokit/octokit.js) is not added
  alongside `@actions/github`. Use it only if a future non-Action consumer
  needs a direct Octokit adapter.
- [`actionlint`](https://github.com/rhysd/actionlint) is a CI validation tool.
  It is not bundled into an Action.
- [`act`](https://github.com/nektos/act) is an optional local smoke-test tool.
  It is not evidence for GitHub permissions or remote push safety.
- [`@actions/artifact`](https://github.com/actions/toolkit/tree/main/packages/artifact)
  is optional for bounded, redacted diagnostics. It is not part of the
  resolver result contract.
- [`@actions/cache`](https://github.com/actions/toolkit/tree/main/packages/cache)
  is limited to CI dependency caching. It must not cache the target checkout,
  Git state, lockfile workspace, or resolver output.
- [`@actions/tool-cache`](https://github.com/actions/toolkit/tree/main/packages/tool-cache)
  belongs to a future OpenCode or tool-download Action. It is not required for
  the resolver's pinned Docker lockfile path.

Only the selected Action dependencies belong in the committed bundle. The
resolver library must not import Action context, summary, cache, artifact, or
tool-cache APIs.

## Consequences

### Positive

- Git and conflict behavior becomes testable with temporary repositories.
- The workflow becomes a small job composition layer.
- The Action can reuse the same application in future trusted workflows.
- Seqlane application packages remain independent of Action concerns.
- The Seqlane workflow remains portable and executor-neutral.
- The bundle provides one reviewed execution artifact for the Action.

### Negative

- A new private package and package build target must be maintained.
- The Action bundle must include all runtime dependencies.
- The application needs explicit ports for GitHub, Git, files, containers, and
  Seqlane execution.
- Some bootstrap values remain in the workflow because checkout happens before
  the Action can inspect the target repository.

### Security consequences

- The workflow must load the Action artifact from the trusted workflow
  revision. The target checkout is data and must never provide executable
  Action or Seqlane source.
- Git commands must use argument arrays and explicit working directories.
- Push behavior must remain opt-in at the application contract boundary.
- Rebase pushes must use an exact `--force-with-lease` expectation.
- Secret values must be masked before any Action log or summary write.

## Follow-up constraints

- Do not place GitHub API types in `@seqlane/core`, Plans, workflow source, or
  runner IPC.
- Do not make `libs/seqlane-core`, `libs/seqlane-runtime`, the CLI, or generic
  workflow packages depend on `libs/action-merge-conflict-resolution`.
- Do not create a generic GitHub Action support package for this migration.
- Do not create new Action-specific libraries with the `seqlane-` directory
  prefix.
- Do not place OpenCode model, permission, or connection data in the generic
  conflict-resolution workflow.
- Do not import source files or `dist` files through relative paths across
  package boundaries.
- Use declared workspace dependencies and package exports.
- Keep expected Git conflicts and empty commits as modeled outcomes.
- Keep the old workflow helper only as a temporary migration shim.
- Update the Action bundle whenever Action source or library dependencies change.

## Revisit conditions

Revisit this decision when multiple Actions require a stable shared lifecycle
or GitHub platform contract, when Actions need separate release versioning, or
when the conflict resolver becomes a public product package.

## Traceability

- [adr.dedicated-runner-process](./2026-09-02-dedicated-runner-process.md)
- [adr.executor-neutral-workflow-authoring](./2026-09-02-executor-neutral-workflow-authoring.md)
- [adr.autonomous-non-interactive-execution](./2026-09-02-autonomous-non-interactive-execution.md)
- [adr.local-mechanical-tasks](./2026-09-03-local-mechanical-tasks.md)
- [task.resolve-pull-request-merge-conflicts](../tasks/2026-09-04-resolve-pull-request-merge-conflicts.md)
