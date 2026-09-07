---
id: task.adopt-opencode-tool-setup-in-review-workflow
title: Adopt OpenCode Tool Setup in the Review Workflow
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.opencode-tool-setup-action
  - task.add-opencode-tool-setup-action
  - task.require-explicit-opencode-server-executable
supersedes: []
---

# Adopt OpenCode Tool Setup in the Review Workflow

## Objective

Use `actions/setup-opencode` in the review workflow. Remove the inline
OpenCode installer and pass the verified executable to the Server Action.

## Upstream requirements

Implement the workflow contract in
[spec.opencode-tool-setup-action](../specs/2026-09-08-opencode-tool-setup-action.md).

Use the Setup Action from
[task.add-opencode-tool-setup-action](./2026-09-08-add-opencode-tool-setup-action.md).

Use the required Server Action input from
[task.require-explicit-opencode-server-executable](./2026-09-08-require-explicit-opencode-server-executable.md).

## Scope

- Remove the inline OpenCode installer from
  `.github/workflows/seqlane-code-review.yml`.
- Retain the workflow's explicit SDK and CLI version matching policy.
- Derive the SDK version and compare it with the workflow CLI version.
- Call `actions/setup-opencode` with the matched version.
- Pass the Setup Action's absolute `executable` output to
  `actions/opencode-server`.
- Retain the existing OpenCode configuration and credentials in the workflow.
- Add workflow checks for the setup and server step wiring.

## Out of scope

- Setup Action implementation, release resolution, integrity verification, or
  caching.
- Server Action input parsing, lifecycle code, or bundle changes.
- Changes to OpenCode configuration, credentials, permission policy, or review
  behavior.
- Changes to the review runner or Seqlane application contracts.

## Implementation plan

1. Add a workflow step that derives the SDK version and compares it with the
   explicit CLI version.
2. Replace the inline installer with `actions/setup-opencode` and pass the
   matched version.
3. Pass the setup output as the required `executable` input to the Server
   Action.
4. Retain the current configuration, credentials, working directory, host,
   port, and startup timeout values.
5. Add YAML and actionlint checks for the resulting workflow.

## Affected areas

- `.github/workflows/seqlane-code-review.yml`

## Verification

Parse `.github/workflows/seqlane-code-review.yml` as YAML. Run `actionlint`
when it is available.

Prove that the workflow contains no inline OpenCode installer. Prove that the
workflow passes the matched SDK version to the Setup Action. Prove that it
passes the absolute output to the Server Action.

Prove that the existing OpenCode configuration and credentials remain in the
Server Action step.

Run `pnpm docs:index`, `pnpm docs:validate`, and `git diff --check`.

## Completion criteria

- The review workflow contains no inline OpenCode installer.
- The workflow retains explicit SDK and CLI version matching.
- The Setup Action receives the matched version.
- The Server Action receives the Setup Action's absolute executable output.
- OpenCode configuration and credentials remain workflow-owned.
- YAML and actionlint checks pass when the tools are available.
- SDLC and diff checks pass.

## Outcome

This task is planned. The review workflow still uses its inline installer.

## Traceability

- [spec.opencode-tool-setup-action](../specs/2026-09-08-opencode-tool-setup-action.md)
- [task.add-opencode-tool-setup-action](./2026-09-08-add-opencode-tool-setup-action.md)
- [task.require-explicit-opencode-server-executable](./2026-09-08-require-explicit-opencode-server-executable.md)
