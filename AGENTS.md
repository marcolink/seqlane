# Seqlane Agent Guide

## Project and scope

- TypeScript monorepo using pnpm and Nx.
- `libs/core` owns public, engine-independent authoring contracts and Plan IR.
- `libs/protocol` owns consumer-agnostic serialized execution events and runner IPC contracts. It is a published CLI dependency, not a supported authoring API.
- `libs/runtime` owns the private Effect v4 execution path. CLI, direct, HTTP, and MCP callers use one Plan program. Follow [spec.effect-v4-execution-and-operations](docs/sdlc/specs/2026-10-21-effect-v4-execution-and-operations.md).
- Name concrete agent adapter packages `@seqlane/<id>-adapter` and give their
  Nx projects the `adapter:concrete` tag. Keep `libs/runtime` tagged
  `boundary:generic-runtime` so module-boundary lint rejects concrete adapter
  dependencies.
- `libs/fixtures` owns private test fixtures and fixture contract tests; expose only intentional fixture subpaths.
- GitHub Action code is CI and platform integration code, not Seqlane application code. New Action-specific libraries must use short, purpose-specific directory names. Do not create a generic Action support library for one Action.
- Keep runtime-engine types and dependencies out of core, serialized Plans, and public workflow-author APIs.
- Keep executor implementations, including OpenCode, out of workflow definitions, serialized Plans, public APIs, runner IPC, and documented CLI/configuration. Follow [adr.executor-neutral-workflow-authoring](docs/sdlc/adrs/2026-09-02-executor-neutral-workflow-authoring.md) when changing these boundaries.
- For standalone CLI runs, `--adapter <id>` is the explicit operator-facing exception. Adapter connection details and implementation types remain private. Follow [adr.standalone-cli-runs](docs/sdlc/adrs/2026-09-16-standalone-cli-runs.md); this decision does not establish runtime delivery.
- Effect v4 owns execution, concurrency, resource lifetime, HTTP, SQL, and telemetry. Seqlane owns its public DSL, coding-task semantics, session and workspace policy, Work identity and provenance, executor contracts, and CLI experience.
- Keep Effect runtime types behind the private runtime boundary. They must not leak into public DSL types, serialized definitions, executor-independent contracts, or stable CLI results. Keep Zod as the canonical public and wire-contract validator, and keep Oclif for CLI commands and conventions.
- Read [prd.seqlane-runtime](docs/sdlc/prd/2026-10-21-seqlane-runtime.md), [rfc.effect-v4-migration](docs/sdlc/rfcs/2026-10-21-effect-v4-migration.md), and [spec.effect-v4-execution-and-operations](docs/sdlc/specs/2026-10-21-effect-v4-execution-and-operations.md) before changing runtime boundaries. These define requirements and architecture; delivery needs source and verification evidence.
- For SDLC documents, follow [the SDLC agent instructions](docs/sdlc/AGENTS.md).
- Treat SDLC lifecycle states as document metadata, not as proof that code is delivered. An accepted ADR records a decision. An active spec defines a contract. A completed task records a historical document claim. None of these states alone proves implementation on the current target branch.
- For delivery claims, inspect the current target-branch source, tests, and configuration. Require a reachable delivery commit or a merged pull request whose result is reachable from that target branch. Do not use a local branch, disconnected worktree, task or spec status, index row, or pull-request label as sole evidence.
- Use pnpm and keep `pnpm-lock.yaml` synchronized.
- Breaking changes are allowed in this phase. Preserve observable behavior unless a behavior change is intentional, documented, and tested.

## Structure and design

- Keep one primary concern per file. Separate domain rules, orchestration, validation, serialization, I/O, and presentation.
- Keep modules cohesive. Treat oversized or mixed-responsibility files as extraction candidates; do not add unrelated logic to them.
- Simplify control flow and abstractions. Prefer direct, readable code over cleverness, deep nesting, or unnecessary indirection.
- Introduce meaningful abstractions for repeated behavior. Do not copy logic or create premature generic frameworks.
- Keep pure transformations separate from side effects. Orchestration coordinates operations; it does not own every policy.
- Across package boundaries, use declared dependencies and package exports; never use relative source or `dist` paths.
- Keep `libs/core` free of runtime-engine dependencies and types.

## Runtime integration

- Follow the active runtime spec and the installed pinned Effect APIs. Verify package exports, declarations, official documentation, and focused behavior before relying on an API.
- Use Effect for application execution, concurrency, resource ownership, time, retries, streams, and operational telemetry. Preserve Seqlane's Plan semantics and public behavior.
- Keep pure transformations pure. Keep SDK Promise/callback interop at owned integration edges, and evaluate Effect programs only at documented boundaries.
- `defineShellTask` and `context.exec` must use the Effect process integration without constructing an agent or invoking a model.
- Native coding-agent SDKs remain adapter-owned. Keep SDK-specific escape hatches private and document capability gaps.
- Keep one execution program. Do not add an engine selector or fallback. Audit tracked contents, filenames, dependencies, and rebuilt distributions before release.
- Preserve complete canonical observations. Telemetry is a derived projection; optional export failure cannot change a run result.
- Standalone runs create no listener or retained history. The explicit host owns versioned SQL history and inspection; restart marks unfinished runs interrupted without replay.

## Git and pull requests

- This is an independent project. Branch names, commits, and pull requests do not require a Jira or other ticket ID.
- Use concise Conventional Commit subjects and pull request titles without ticket suffixes.
- Keep pull request descriptions focused on intent, behavior, scope, stack position, and verification.
- Do not add tool attribution, AI-generation notes, agent credits, or “created with” boilerplate to commits or pull request descriptions.

## Runtime contracts and errors

- Treat HTTP, CLI, file, SSE, IPC, and subprocess data as untrusted input.
- Use Zod schemas as the source of truth for runtime validation and inferred types. `libs/core` may depend on Zod; keep schemas in the package that owns each contract.
- Never replace an `unknown` value with a type assertion, generic constraint, or broad type such as `object`. Parse it with the owning Zod schema before use.
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
- Runtime integration changes require focused integration tests and public-boundary checks for leaked engine types.
- Prove that deterministic tasks make zero model calls.
- Optimize measured bottlenecks. Do not add speculative caching, complexity, or abstractions without evidence.
