# TS-011-00 — Bootstrap the Output Package and Renderer Contract

**Status:** completed

## Use Case

**As a** Seqlane maintainer, **I want to** have a private output package with a
stable renderer boundary, **so that** CLI presentation does not leak into core
or runtime contracts.

## Scope

- Create libs/seqlane-output as @seqlane/output.
- Add Nx project metadata, TypeScript configuration, package metadata, and
  explicit exports.
- Define the renderer mode, output sink, renderer factory, and renderer
  lifecycle contracts.
- Add a minimal testable no-op or recording renderer fixture.
- Add the package as a workspace project without wiring it into the CLI yet.

## Out of Scope

- Runner event changes.
- Human view-model reduction.
- ANSI terminal rendering.
- CI or JSON rendering.
- CLI flags and integration.
- Mastra, OpenCode, or runtime dependencies.

## Implementation Notes

The package may import runner event types from @seqlane/core. Keep
the output sink injectable so tests do not depend on process stdout or a TTY.
Do not expose terminal-library types from the package contract.

## Acceptance Criteria

**Scenario:** The output package builds
- **Given:** The new workspace package
- **When:** Nx builds seqlane-output
- **Then:** JavaScript and declarations are emitted under its own dist directory

**Scenario:** The package exports its contract
- **Given:** A compiled package consumer
- **When:** It imports the supported package entrypoint
- **Then:** It can access the renderer factory and contract types through package exports

**Scenario:** The package preserves boundaries
- **Given:** The package manifest and source imports
- **When:** They are inspected
- **Then:** They contain no Mastra, OpenCode, seqlane-runtime, or process-termination dependency

**Scenario:** The renderer is testable
- **Given:** An injected recording output sink
- **When:** A renderer receives an event
- **Then:** The test can inspect output without using a real terminal

## Source

- [ADR-011 — Isolate Seqlane Execution Output](../../ADR-011-dedicated-seqlane-output-package.md)
- [TS-011 — Seqlane Execution Output Package](../../TS-011-seqlane-execution-output-package.md)
- [RFC-002 — Seqlane Execution Observability and Debugging](../../RFC-002-execution-observability-and-debugging.md)
