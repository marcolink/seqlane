---
id: task.workflow-discovery-and-plan-cli
title: Add Workflow Discovery and Plan Commands
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Add Workflow Discovery and Plan Commands

## Objective

Make repository and user workflows discoverable and inspectable before a run.

## Dependencies

- [task.mastra-architectural-cleanup](./2026-09-03-mastra-architectural-cleanup.md)
- [task.workflow-discovery-bounds](./2026-09-05-workflow-discovery-bounds.md)

## Delivery

- Stack order: 14
- Branch: `mastra-14-workflow-discovery-plan`
- Pull request base: `mastra-13-workflow-discovery-bounds`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Upstream requirements

- `requirement-workflow-discovery`
- `requirement-workflow-discovery-bounds`
- `requirement-cli-operator-commands`
- `requirement-public-boundary`

## Scope

- Define and document the default repository and user discovery roots.
- Use the shared root-containment and discovery-limit policy.
- Define one Zod-validated workflow descriptor format.
- Preserve workflow name, scope, module reference, export name, and description.
- Resolve `repository:<name>` and `user:<name>` references.
- Reject ambiguous unqualified names and list all qualified matches.
- Keep direct module and file references working.
- Add `seqlane list` with human and JSON output.
- Add `seqlane plan <workflow>` with human and JSON output.
- Prove that list and plan operations make no executor or model call.

## Out of scope

- A central registry, remote catalog, or package manager.
- Workflow execution, status, cancellation, MCP, or Studio.
- Generated TypeScript catalogs or virtual import modules.

## Implementation plan

1. Specify the discovery roots and descriptor schema.
2. Build pure descriptor discovery and name resolution.
3. Reuse the existing workflow loader for the selected descriptor.
4. Add list and plan commands with stable output schemas.
5. Add ambiguity, malformed-input, and zero-model-call tests.
6. Update CLI and workflow author documentation.

## Affected areas

- `apps/seqlane-cli`
- `libs/seqlane-core`
- private workflow loading and validation modules
- CLI and workflow author documentation

## Verification

- Repository-only and user-only workflows resolve by qualified name.
- A unique unqualified name resolves to one descriptor.
- A cross-scope collision fails and lists each qualified name.
- Malformed descriptors fail before module import.
- `list` does not import or execute workflow source.
- `plan` compiles but does not execute work.
- Direct workflow references remain compatible.

## Completion criteria

Operators can list and plan repository and user workflows without hidden scope
precedence or runtime work.

## Outcome

Implemented repository and user descriptor discovery with strict Zod
validation. Qualified names, unique names, ambiguity errors, and direct module
references now use one workflow resolution path.

Added `seqlane list` and `seqlane plan` with human and validated JSON output.
The `run` command now accepts the same discovered names. List does not import
workflow modules. Plan compiles the selected workflow without executing tasks,
processes, executors, or models.

Updated the CLI and core documentation. Verified the implementation with the
full repository typecheck, test, lint, build, format, Nx sync, and SDLC gates.
The built CLI end-to-end suite passed 25 tests, and the test-mapping check
passed 154 mappings.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [adr.repository-user-workflow-discovery-and-composition](../adrs/2026-09-02-repository-user-workflow-discovery-and-composition.md)
- [prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
