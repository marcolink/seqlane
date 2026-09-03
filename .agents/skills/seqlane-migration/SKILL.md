---
name: seqlane-migration
description: Migrate one Seqlane runtime capability to Mastra while preserving the intentional public contract and deleting the superseded implementation.
---

# Seqlane Migration

Use this skill for implementation or review of an old-to-Mastra migration slice. The outcome is a smaller single-runtime system, not an adapted copy of the old architecture.

Read [the Mastra PRD](../../../docs/sdlc/prd/2026-09-03-seqlane-on-mastra.md), [the Mastra runtime RFC](../../../docs/sdlc/rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md), and the root `AGENTS.md` before changing boundaries.

## Target mappings

| Existing Seqlane concept | Target                                                      |
| ------------------------ | ----------------------------------------------------------- |
| Workflow definition      | Mastra workflow registration                                |
| Agent task               | Mastra step plus agent/ACP invocation                       |
| Shell task               | Mastra step plus Workspace/Sandbox process                  |
| `dependsOn`              | Mastra graph dependency                                     |
| Work                     | Mastra workflow run plus Seqlane metadata/context           |
| Invocation               | Mastra step execution plus Seqlane metadata                 |
| Shared session           | Stable runtime thread/session key, serialized in graph      |
| Branch session           | Independent derived runtime thread/session; no merge        |
| Workspace rule           | Added graph/admission constraint                            |
| Run persistence          | Mastra storage                                              |
| Tracing                  | Mastra tracing plus a minimal normalized CLI event contract |
| Server/MCP               | Mastra facilities plus thin Seqlane registration            |
| Studio                   | Upstream Community Studio launched by `seqlane studio`      |

## Migrate a slice

1. **Inventory behavior.** Locate the public contract, implementations, callers, tests, exports, dependencies, Nx projects, docs, and configuration. Separate intentional behavior from historical implementation.
2. **Select the Mastra primitive.** Use `$mastra` and verify the pinned API. State any real capability gap.
3. **Define the surviving Seqlane policy.** Keep only coding-specific behavior or a stable public boundary. Do not preserve a generic runtime abstraction for hypothetical engines.
4. **Implement vertically.** Compile or route one end-to-end path through Mastra, including identity, schema validation, errors, cancellation, and observability.
5. **Switch callers.** Make Mastra the only production path for the slice. Do not leave a silent fallback or dual write.
6. **Delete immediately.** Use `$architectural-cleanup` to remove the superseded implementation and all support material.
7. **Validate.** Run focused behavior/integration tests and the repository's affected lint, typecheck, test, and build targets.

## Rules for bridges

A temporary bridge is permitted only when the slice cannot be switched atomically. Document:

- the exact callers still using it;
- why they cannot switch in the current change;
- the objective removal condition;
- the next deletion step.

Do not call a permanent forwarding layer a bridge. Remove every bridge before declaring the overall migration complete.

## Review questions

- Did the change preserve product semantics or merely preserve old code shape?
- Could a Mastra primitive replace more of the new code?
- Is the normalized Seqlane model still only a compiler input, or is it becoming another runtime?
- Does any old path remain reachable?
- Were stale tests rewritten around the surviving contract rather than carried forward?
- Were dependencies, exports, docs, config, packages, and Nx projects cleaned up?
- Is the production-code delta meaningfully negative for a replaced generic capability?

Finish with a migration ledger: **kept**, **replaced**, **deleted**, **remaining**, and **validated**.
