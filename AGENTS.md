# Seqlane Agent Guide

## Project and scope

- Foundation-only TypeScript monorepo using pnpm and Nx.
- `libs/seqlane-core` owns public, engine-independent authoring contracts and Plan IR.
- `libs/seqlane-events` owns public, consumer-agnostic serialized execution-event contracts.
- `libs/seqlane-runtime` owns private Effect-based execution.
- `libs/seqlane-fixtures` owns private test fixtures and fixture contract tests; expose only intentional fixture subpaths.
- Keep runtime-engine types and dependencies out of core, serialized Plans, and public workflow-author APIs.
- Keep executor implementations, including OpenCode, out of workflow definitions, serialized Plans, public APIs, runner IPC, and documented CLI/configuration. Follow [ADR-008](docs/ADR-008-executor-neutral-workflow-authoring.md) when changing these boundaries.
- Use pnpm and keep `pnpm-lock.yaml` synchronized.
- Breaking changes are allowed in this phase. Preserve observable behavior unless a behavior change is intentional, documented, and tested.

## Structure and design

- Keep one primary concern per file. Separate domain rules, orchestration, validation, serialization, I/O, and presentation.
- Keep modules cohesive. Treat oversized or mixed-responsibility files as extraction candidates; do not add unrelated logic to them.
- Simplify control flow and abstractions. Prefer direct, readable code over cleverness, deep nesting, or unnecessary indirection.
- Introduce meaningful abstractions for repeated behavior. Do not copy logic or create premature generic frameworks.
- Keep pure transformations separate from side effects. Orchestration coordinates operations; it does not own every policy.
- Across package boundaries, use declared dependencies and package exports; never use relative source or `dist` paths.
- Keep `seqlane-core` free of Mastra dependencies and types.

## Runtime contracts and errors

- Treat HTTP, CLI, file, SSE, IPC, and subprocess data as untrusted input.
- Use Zod schemas as the source of truth for runtime validation and inferred types. `seqlane-core` may depend on Zod; keep schemas in the package that owns each contract.
- Derive types with `z.infer`, `z.input`, or `z.output` as appropriate. Use `schema.safeParse(value).success` for type guards only when the schema does not transform its input.
- Do not expose or maintain standalone handwritten runtime predicate functions. When a constraint cannot be expressed structurally, encapsulate it in the owning schema with `z.custom<T>(predicate)` or `.pipe(z.custom<T>(predicate))`.
- Do not use `.refine()` for type narrowing; Zod 4 does not support it.
- Define one canonical schema or normalizer per shared contract. Reuse it instead of duplicating validators or shape definitions.
- Do not use unchecked `JSON.parse`, `response.json()`, or `as unknown as` to make unvalidated data fit a type.
- Restrict type casts to narrow, isolated third-party or platform interop boundaries; document non-obvious casts.
- Use typed domain errors at package boundaries, preserve the original `cause`, and never make behavior depend on error-message text.
- Structured-output tasks require model tool-calling support and access to OpenCode's internal `StructuredOutput` tool, but require no workspace write capability. A blanket OpenCode tool denial must explicitly allow `StructuredOutput`.

## Tests and optimization

- Tests must prove observable behavior, public contracts, invariants, malformed-input handling, or regressions. Do not add implementation-detail or coverage-only tests.
- Every test must map to implementation files for fast scoped runs: colocate `module.spec.ts(x)` or `module.test.ts(x)` with `module.ts(x)`; cross-module tests must declare one or more valid `@test-scope` implementation paths.
- Keep test-to-implementation mapping machine-checkable. Run the repository test-mapping check before the test suite; unmapped or stale targets are errors.
- Protocol and serialization changes require compatibility tests and malformed-input tests.
- Optimize measured bottlenecks. Do not add speculative caching, complexity, or abstractions without evidence.
