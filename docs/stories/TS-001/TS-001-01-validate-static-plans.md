# TS-001-01 — Make static plans deterministic before execution

**Status:** completed


## Use Case
**As a** workflow author, **I want to** have my static Plan validated and ordered deterministically, **so that** the same workflow executes predictably every time.

## Acceptance Criteria
**Scenario:** *Valid static Plan is prepared for execution*
- **Given:** A static Seqlane Plan contains valid TaskNodes and dependency relationships
- **When:** The runtime compiles the Plan
- **Then:** The Plan is validated and deterministically topologically sorted before Mastra workflow creation

**Scenario:** *Invalid static Plan is rejected*
- **Given:** A static Seqlane Plan fails Plan validation
- **When:** The runtime attempts compilation
- **Then:** Compilation fails before a runnable Mastra workflow is committed

## Technical Details
The `MastraCompiler` owns Plan validation, deterministic topological ordering, and workflow construction. The Seqlane Plan remains the authoritative representation of the dependency graph.

## Out of Scope
- Parallel Plan lowering
- Branch, loop, and foreach lowering
- Persisted workflow execution

## Source
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-001 — Mastra Runtime Integration](../../TS-001-mastra-runtime-integration.md)
