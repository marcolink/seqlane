---
name: effect-v4-runtime
description: Verify and use repository-pinned Effect v4 APIs for Seqlane runtime work under the active migration spec.
---

# Effect v4 runtime

Use this guidance for new runtime work under [the active execution and operations spec](../../../docs/sdlc/specs/2026-10-21-effect-v4-execution-and-operations.md). Migration delivery is incomplete until its task slices and final removal audit have evidence.

## Establish the source of truth

Before changing runtime integration code:

1. Inspect the package manifest and lockfile for exact Effect package versions.
2. Inspect installed exports, declarations, or source.
3. Consult current official documentation for the pinned version.
4. Confirm uncertain behavior with a focused typecheck or executable test.
5. Check Snyk before adding or changing dependencies.

Do not infer companion package versions from the core package version. Avoid unstable APIs unless their use is isolated behind an owned integration seam and covered by focused verification.

## Ownership

- Effect owns application execution, concurrency, resource lifetime, time, retries, streams, and operational telemetry.
- Seqlane owns Plan meaning, task behavior, admission policy, identity, provenance, and stable outcomes.
- Public and wire schemas remain Zod-owned. CLI commands and conventions remain Oclif-owned.
- Keep Effect types behind the private runtime boundary. Keep native SDK types and lifecycle behind adapter boundaries.
- Keep pure transformations pure. Convert SDK Promises and callbacks once at the owning integration edge.
- Evaluate Effect programs only at documented composition boundaries. Preserve scope, parent span, interruption, and original cause.
- A deterministic shell task must not construct an agent or invoke a model.

## Verification

For each touched capability, prove behavior through the real caller and test relevant error, cancellation, cleanup, and public-boundary behavior. Use a real subprocess when proving OS process termination. Confirm public declarations and wire output contain no Effect runtime state.
