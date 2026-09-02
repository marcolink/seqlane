# TS-022-07 — Complete Integration Compatibility Coverage and Documentation

**Status:** planned

## User outcome

As a workflow author, the model-selection contract is documented, compatible
with existing session workflows, and verified through the full repository gate.

## Scope

- Add end-to-end fixture coverage for isolated, reuse, branch, and child model
  selections.
- Verify legacy workflows and Plans without model fields.
- Update package and architecture documentation with examples and constraints.
- Run the complete verification gate and docs-sync review.

## Out of scope

New providers, Codex support, automatic fallback, and unrelated cleanup.

## Acceptance criteria

**Scenario:** *Legacy compatibility*

- **Given:** an existing workflow without model selection
- **When:** it compiles and runs with OpenCode
- **Then:** it resolves the configured executor default without Plan changes

**Scenario:** *Complete workflow*

- **Given:** a workflow using explicit, inherited, and branched selections
- **When:** it runs through the OpenCode fixture adapter
- **Then:** validation, session behavior, fork initialization, and events all
  satisfy ADR-022

## Source

- [ADR-022](../../ADR-022-model-selection-and-session-model-semantics.md)
- [TS-022](../../TS-022-model-selection-and-session-model-semantics.md)
