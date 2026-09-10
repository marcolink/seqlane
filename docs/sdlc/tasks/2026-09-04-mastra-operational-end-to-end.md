---
id: task.mastra-operational-end-to-end
title: Prove One Run Across All Mastra Operational Surfaces
status: planned
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Prove One Run Across All Mastra Operational Surfaces

## Objective

Prove that discovery, CLI, API, MCP, storage, tracing, and Studio share one run.

## Dependencies

- [task.workflow-discovery-and-plan-cli](./2026-09-04-workflow-discovery-and-plan-cli.md)
- [task.cli-run-status-and-cancel](./2026-09-04-cli-run-status-and-cancel.md)
- [task.mastra-mcp-transports](./2026-09-04-mastra-mcp-transports.md)
- [task.mastra-studio-run-inspection](./2026-09-04-mastra-studio-run-inspection.md)

## Delivery

- Stack order: 20
- Branch: `mastra-20-operational-end-to-end`
- Pull request base: `mastra-19-studio-run-inspection`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Upstream requirements

- `requirement-cross-surface-run`
- `requirement-local-operational-access`
- `requirement-operational-data-bounds`
- `requirement-storage-tracing`
- `requirement-delete-replaced-code`
- `requirement-community-license`

## Scope

- Add one automated cross-surface test for a representative mixed workflow.
- Discover and plan the workflow before execution.
- Start it through the CLI and inspect it through status and Mastra APIs.
- Cancel an active run and verify the normalized terminal outcome.
- Run a deterministic workflow through each MCP transport.
- Verify the same identities, state, steps, and traces in every surface.
- Verify that Community Studio can query the same stored run.
- Repair and test the source development CLI entry point.
- Update installation, command, MCP, server, and Studio documentation.
- Run the full repository and architecture gates.

## Out of scope

- Publishing a package or creating installers.
- Remote deployment, hosted services, or enterprise features.
- Performance, load, or multi-user testing.
- New workflow authoring features.

## Implementation plan

1. Build a hermetic operational test harness with temporary storage and ports.
2. Exercise discovery, planning, run, status, cancel, API, MCP, and Studio APIs.
3. Assert identity and storage equality across every observation point.
4. Fix the source CLI launcher and cover built and development entry points.
5. Remove stale direct-only helpers, docs, flags, and tests.
6. Run the repository, boundary, and Community-license gates.

## Affected areas

- operational end-to-end tests
- CLI entry points
- runtime integration fixtures
- package and root documentation
- architecture boundary checks

## Verification

- One CLI-started run has one Work ID and one Run ID everywhere.
- One MCP-started run is visible through API, storage, tracing, and Studio.
- Every task invocation appears as one Mastra step.
- Cancellation reaches active agent and process work where supported.
- A deterministic path makes zero model calls.
- Built and source development CLI entry points expose the same commands.
- No in-memory-only operational default or in-process-only transport remains.
- Typecheck, test, lint, build, format, Nx sync, and docs validation pass.

## Completion criteria

The PRD and RFC operational success criteria have one repeatable end-to-end
proof, and no documented run mode depends on an internal test helper.

## Outcome

Not started.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
