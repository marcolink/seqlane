---
name: mastra
description: Verify and use the repository-pinned Mastra APIs when implementing or reviewing Seqlane workflows, steps, storage, agents, ACP, workspaces, tracing, server, MCP, or Studio integration.
---

# Mastra

Use Mastra as Seqlane's sole generic runtime. Keep Seqlane-specific policy thin and keep Mastra types behind the public authoring boundary.

## Establish the source of truth

Mastra APIs change quickly. Before editing integration code:

1. inspect the repository manifest and lockfile to identify the exact packages and versions;
2. inspect the installed package's exported TypeScript declarations or source;
3. consult current official documentation that matches the installed major/minor version;
4. confirm uncertain behavior with a minimal typecheck or focused executable test.

Prefer package exports and TypeScript types over blog examples. Never invent an import path, method name, option, event, or return shape. If the pinned version lacks the required capability, report the concrete gap before adding a workaround or dependency upgrade.

## Choose the native primitive

Map requirements to Mastra in this order:

- workflow/step/graph APIs for execution and ordering;
- supported schema integration for step boundaries;
- request context or metadata for Seqlane Work/Invocation correlation;
- configured storage for canonical runtime state;
- Workspace filesystem plus Sandbox/process APIs for commands;
- agents, `createCodingAgent`, or ACP for coding-agent work;
- native tracing/observability for operational detail;
- native server and MCP registration;
- upstream Community Studio for inspection.

Do not create a Seqlane abstraction that merely renames a Mastra primitive unless it protects the stable public DSL or adds a real coding-specific rule.

## Boundary rules

- Public/core Seqlane modules must not import Mastra.
- Mastra objects, errors, config types, and lifecycle handles stay inside the integration layer.
- Normalize errors and results before they cross into CLI/public contracts.
- Express static session/workspace constraints as graph structure before execution.
- Use Mastra storage as canonical runtime state; do not dual-write a Seqlane copy.
- Use the Mastra retry/cancellation mechanisms rather than wrapping the entire run with a competing engine.
- A deterministic shell step must not create or invoke an agent.

## License boundary

- Use only Community/open-source packages and paths.
- Reject imports or copied code from any `/ee/` directory.
- Do not require Mastra Cloud or enterprise-only auth/RBAC/features.
- Treat an upgrade as a license-review event as well as an API change.

## Verification

For the touched capability, verify:

- imports resolve against the pinned dependency;
- TypeScript types prove the intended input/output path;
- a focused integration test exercises real Mastra behavior;
- cancellation/error behavior is normalized;
- public declarations contain no accidental Mastra types;
- no `/ee/` import or enterprise-only requirement was introduced.

Record the pinned version and the specific source/type/docs used when an API choice is non-obvious.
