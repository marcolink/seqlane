---
id: task.seqlane-action-runtime-adapters
title: Add Seqlane Action GitHub and Runtime Adapters
status: completed
owners:
  - core
created: 2026-09-06
updated: 2026-09-06
upstream:
  - spec.seqlane-action-merge-conflict-resolution
supersedes: []
---

# Add Seqlane Action GitHub and Runtime Adapters

## Objective

Add the injected adapters that connect the Action application to GitHub,
lockfile regeneration, Seqlane execution, and OpenCode.

## Upstream requirements

Implement `requirement-pull-request-preflight`,
`requirement-lockfile-regeneration`, `requirement-seqlane-and-opencode`, and
`requirement-dependency-and-tooling-boundary`, and
`requirement-observability-and-secrets` from
[spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md).

Depend on:

- [task.seqlane-action-resolution-contracts](./2026-09-06-seqlane-action-resolution-contracts.md)
- [task.seqlane-action-git-workspace-boundary](./2026-09-06-seqlane-action-git-workspace-boundary.md)

Run the required dependency security review before adding any new package.
Use the existing OpenAI, OpenCode, Docker, pnpm, and Seqlane dependencies when
they meet the contract.

## Scope

- Add a GitHub metadata port and a typed response adapter.
- Read and validate pull-request metadata through the `@actions/github`
  adapter created by the Action entrypoint.
- Read and validate the live base branch revision.
- Add workflow revision and summary metadata inputs.
- Add a lockfile adapter with a fresh temporary workspace per attempt.
- Copy only tracked package manifests and `pnpm-workspace.yaml` into that
  workspace.
- Preserve 64-file, 512 KiB per-file, and 2 MiB total input limits.
- Read an exact pnpm version from the trusted source `package.json`.
- Run the pinned Docker image with direct arguments.
- Preserve Corepack, npm registry, `--lockfile-only`, `--ignore-scripts`, and
  `--ignore-pnpmfile` behavior.
- Add an agent-runner port for the generic conflict-resolution workflow.
- Keep the workflow input and output schemas executor-neutral.
- Add the private Seqlane runtime adapter required by the bundled Action.
- Install and hash-check OpenCode version `1.18.27`.
- Configure loopback-only OpenCode with the current permission policy.
- Start OpenCode only when the conflict set contains an agent file.
- Stop OpenCode in an idempotent cleanup function.
- Keep this lifecycle resolver-specific. Do not create a generic OpenCode
  service library in this package. Treat the separate OpenCode Action pattern
  as an integration option for a later contract.
- Add bounded event recording and secret redaction hooks.

## Out of scope

- Resolution state transitions.
- Git conflict detection or staging.
- Action Toolkit input parsing.
- Workflow YAML changes.
- New public executor or workflow-authoring contracts.
- OpenCode permission changes.

## Implementation plan

1. Define the GitHub metadata port with only the fields required by the
   resolver.
2. Validate API responses with Zod before they enter the controller.
3. Use the current repository identity as the same-repository boundary.
4. Read the base branch ref after the pull-request response.
5. Keep workflow and Action revision values separate from pull-request values.
6. Implement lockfile input preparation with the typed workspace boundary.
7. Pass Docker arguments as an array and bind only the temporary workspace.
8. If `@actions/exec` is used, pass the executable and arguments separately
   and keep secrets out of command arguments and logs.
9. Make the lockfile command use the trusted exact pnpm version.
10. Define a Seqlane runner port that returns structured success or failure.
11. Keep the Action bundle self-contained. Do not require `pnpm install` in
    the consuming workflow.
12. If the current CLI cannot be bundled without importing an application
    boundary, add a private runtime-facing entrypoint instead of importing
    internal files through relative paths.
13. Keep OpenCode installation and lifecycle outside the generic workflow
    module.
14. Mask `OPENAI_API_KEY` before starting child processes.
15. Keep raw OpenCode logs out of public workflow output.
16. Add adapter tests with fake GitHub responses, fake agent results, and real
    temporary lockfile workspaces.

## Affected areas

- `libs/action-merge-conflict-resolution/src/github-port.ts`
- `libs/action-merge-conflict-resolution/src/github-client.ts`
- `libs/action-merge-conflict-resolution/src/lockfile-port.ts`
- `libs/action-merge-conflict-resolution/src/lockfile-docker.ts`
- `libs/action-merge-conflict-resolution/src/agent-runner-port.ts`
- `libs/action-merge-conflict-resolution/src/seqlane-agent-runner.ts`
- `libs/action-merge-conflict-resolution/src/opencode-runtime.ts`
- `libs/action-merge-conflict-resolution/src/recording.ts`
- package manifests and lockfile
- colocated adapter tests
- private runtime entrypoint files, if required by bundle design

## Verification

Run these checks:

```text
pnpm run test:mapping
pnpm exec nx run action-merge-conflict-resolution:typecheck
pnpm exec nx run action-merge-conflict-resolution:test
pnpm format:check
git diff --check
```

Test these cases:

- malformed pull-request responses
- fork repository responses
- changed live base branch
- lockfile-only conflict without OpenAI or OpenCode setup
- bounded manifest input
- missing exact pnpm version
- Docker command failure
- archive hash mismatch
- OpenCode readiness timeout
- OpenCode cleanup after agent failure
- secret redaction before logging
- Seqlane success and structured failure.

## Completion criteria

- The controller can obtain validated PR and branch metadata through a port.
- Lockfile regeneration has no model or agent dependency.
- Lockfile regeneration uses a fresh bounded workspace for every attempt.
- The Action can run Seqlane without consumer dependency installation.
- OpenCode starts only for agent conflicts.
- OpenCode uses the pinned archive and current permission policy.
- OpenCode stops before push authentication.
- Runtime and adapter tests do not require a live model service.
- No GitHub or OpenCode implementation type crosses the generic workflow
  boundary.

## Outcome

Completed. Added resolver-scoped GitHub metadata, bounded Docker lockfile,
Seqlane execution, OpenCode lifecycle, and bounded recording adapters. The
library keeps Action Toolkit and GitHub event concerns outside its boundary.
Lockfile regeneration uses fresh temporary workspaces, direct Docker argument
arrays, the pinned Node image, exact trusted pnpm versions, and typed failures.
The OpenCode adapter verifies the pinned archive before extraction, bounds and
times out the archive download, binds only to loopback, applies the existing
deny-by-default policy, waits for health, and performs idempotent cleanup.
Seqlane execution uses declared private package exports and records bounded
redacted events.

Verification passed for the package typecheck and build, 62 focused tests,
`pnpm run test:mapping`, `pnpm format:check`, and `git diff --check`. The
dependency review found current non-vulnerable targets for `@actions/core` and
`@actions/github`; those Action-only dependencies remain for the entrypoint
task and are not imported by this library.

## Traceability

- Contract: [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- Decision: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- OpenCode contract: [spec.opencode-executor-integration](../specs/2026-09-02-opencode-executor-integration.md)
- Runtime contract: [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)
