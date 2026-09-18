---
id: task.scope-merge-conflict-agent-skill
title: Scope the Merge Conflict Agent Skill
status: completed
owners:
  - core
created: 2026-09-18
updated: 2026-09-18
upstream:
  - spec.seqlane-action-merge-conflict-resolution
supersedes: []
---

# Scope the Merge Conflict Agent Skill

## Objective

Make the Git guidance available only to the OpenCode agent in the merge
conflict Action.

## Upstream requirements

Implement `requirement-seqlane-and-opencode` from
[spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md).

## Scope

- Move `seqlane-git-automation` out of the repository skill directory.
- Store the skill under `actions/resolve-merge-conflicts/skills`.
- Register the trusted skill directory in the resolver OpenCode configuration.
- Allow only `seqlane-git-automation` through the OpenCode `skill` tool.
- Disable ambient external skills.
- Keep shell and external-directory access denied.
- Add focused configuration tests.

## Out of scope

- Change the conflict-resolution workflow or prompts.
- Change Git integration, commit, or push behavior.
- Expose the skill to other repository agents or Actions.

## Implementation plan

1. Add a focused test for skill discovery and permissions.
2. Move and narrow the skill instructions.
3. Pass the trusted Action skill path to OpenCode.
4. Validate the skill, runtime configuration, and Action bundle.

## Affected areas

- `actions/resolve-merge-conflicts/skills/`
- `libs/action-merge-conflict-resolution/src/opencode-runtime.ts`
- `docs/sdlc/specs/2026-09-06-seqlane-action-merge-conflict-resolution.md`

## Verification

- Run the skill validator for the moved skill.
- Run the test mapping check.
- Run the focused library tests and type checks.
- Build and test the Action bundle.
- Run the SDLC validation.
- Run the format and Git diff checks.

## Completion criteria

- The repository root does not expose `seqlane-git-automation` as a skill.
- The resolver OpenCode configuration exposes the Action-owned skill.
- The configuration hides all other external skills.
- Existing workspace and tool restrictions remain active.

## Outcome

The Action owns a narrow `seqlane-git-automation` skill. The repository skill
directory no longer exposes this guidance.

The resolver reads the skill directory from the bundled Action module
location. Its OpenCode configuration disables ambient external skills and
project configuration. The permission policy exposes only the Action-owned
skill through the `skill` tool. Shell and external-directory access remain
denied.

The skill validator passed. Test mapping passed for 305 mappings. The focused
library suite passed 124 tests. The Action suite passed four tests and its
entrypoint smoke test. Type checks, lint, bundle creation, SDLC checks,
formatting, Git diff checks, and the Ripwire quality gate passed.

The focused Nx targets used `--skip-sync`. The existing
`apps/cli/tsconfig.json` lacks two project references and blocks the standard
Nx sync check.

## Delivery state

The implementation is complete on its task branch. It is not yet reachable
from `main`.

## Traceability

- [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
