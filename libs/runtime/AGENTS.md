# Runtime Agent Guide

These instructions apply to all files under `libs/runtime/`.

## Adapter boundary

- Keep this package independent of concrete agent adapters.
- Depend on `@seqlane/agent-adapter` for generic contracts only.
- Do not import or declare dependencies on ACP, Codex, OpenCode, or future
  concrete adapter packages.
- Keep concrete adapter configuration, selection, connection details, and
  factories in application composition roots such as `apps/cli`, Actions,
  servers, or workers.
- Tests in this package must use generic fake runtimes or adapters. Do not add a
  concrete adapter as a test dependency.
- Concrete adapter packages own configuration validation and diagnostic
  redaction. The composition root owns runtime creation. The generic runtime
  owns run-scoped adapter and runtime cleanup.

Follow
[the engine-opaque adapter ADR](../../docs/sdlc/adrs/2026-09-18-engine-opaque-agent-adapter-contracts.md)
when changing this boundary.
