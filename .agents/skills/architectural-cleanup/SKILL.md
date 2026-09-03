---
name: architectural-cleanup
description: Remove superseded architecture after a Seqlane-to-Mastra replacement, including dead code, tests, exports, dependencies, configuration, docs, packages, and Nx projects.
---

# Architectural Cleanup

Use this skill after production callers have switched to a Mastra-backed path or when reviewing whether a migration slice is genuinely complete.

The goal is not cosmetic cleanup. It is to prove there is one implementation and one authority for each runtime capability.

## Build the deletion set

Start from the replaced entry point and search both directions:

- implementations and sibling variants;
- imports, callers, registries, factories, dependency-injection wiring, and dynamic loading;
- public exports and generated API reports;
- unit, integration, snapshot, fixture, and end-to-end tests;
- package manifests, lockfile entries, build configuration, Nx projects/targets, path aliases, and CI jobs;
- server routes, MCP tools/resources, persistence migrations, tracing/event code, Studio assets, environment variables, and feature flags;
- documentation, examples, comments, architecture diagrams, and terminology.

Classify each item as surviving contract, replacement coverage, or deletion. Existing code is not evidence that compatibility is required.

## Delete safely

1. Verify all production callers use the replacement.
2. Remove the obsolete implementation and fallback selection logic.
3. Remove exports and registrations.
4. Delete tests that only assert deleted internals; ensure the surviving behavior is covered at the new boundary.
5. Remove dependencies, config, environment variables, packages, Nx projects, CI targets, docs, and assets that have no remaining owner.
6. Regenerate lockfiles or API reports using repository commands when required.
7. Search again for old symbols, paths, feature flags, and architecture language.

Do not retain a compatibility shim, dual implementation, or dormant feature flag unless the task explicitly requires it. If a bridge must remain, document its callers and objective removal condition.

## Migration-specific targets

Actively look for and remove superseded:

- generic workflow engine and scheduler code;
- Effect orchestration/lifecycle/service graphs;
- run-state and persistence implementations;
- retry and cancellation wrappers around the runtime;
- process supervisors replaced by Mastra Workspace/Sandbox;
- generic server and MCP transports;
- parallel tracing/event stores;
- the dedicated Seqlane Studio and its application/build assets;
- wrapper packages that only forward to Mastra.

Never remove the intentional Seqlane DSL, coding semantics, session/workspace policy, Work identity/provenance, executor contract, normalized CLI event/result contract, or CLI UX.

## Validate

Use repository-native commands discovered from configuration. At minimum, run the applicable:

- formatting/lint;
- typecheck;
- focused and affected tests;
- build/package validation;
- public API/dependency-boundary checks;
- license check and search for `/ee/` imports;
- repository searches for deleted symbols and stale language.

Inspect the final diff for unrelated edits, orphaned code, duplicate conditionals, feature logic leaking into shared modules, and compatibility comments with no remaining caller.

Report:

- production files/lines removed and added;
- dependencies and Nx projects removed;
- retained bridges with removal conditions, ideally none;
- validation executed and any checks not run.
