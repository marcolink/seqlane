---
id: task.cli-integration-and-verification
title: Integrate Output Modes with the CLI and Verify Boundaries
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.seqlane-execution-output-package
supersedes: []
---

# Integrate Output Modes with the CLI and Verify Boundaries

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-011-05`.

## Use Case

**As a** Seqlane user, **I want to** select human, CI, or JSON output from the
CLI, **so that** local and automated runs expose the appropriate execution
detail.

## Scope

- Add @seqlane/output as a declared CLI dependency.
- Add the output option: auto, human, ci, or json.
- Select auto mode from TTY and CI capabilities.
- Detect ANSI, Unicode, terminal width, resize, and stdout/stderr routing
  capabilities.
- Pass validated runner events to the selected renderer.
- Finalize the renderer before returning the runner result.
- Preserve runner exit status and cancellation behavior independently of output.
- Remove the direct CLI event projection once the package renderer is wired.
- Add CLI integration tests for local, CI, JSON, failure, and cancellation paths.
- Add package boundary tests and update rfc.execution-observability-and-debugging implementation documentation.

## Out of Scope

- runtime inspection or tracing.
- Persistent execution history.
- A public renderer plugin API.
- Full-screen keyboard navigation.
- New executor or workflow-authoring contracts.
- Rollback or compensation execution.

## Implementation Notes

The CLI remains responsible for flags, capability detection, runner supervision,
summary-file integration, and process exit status. It must not import
seqlane-runtime presentation internals.

JSON mode must not print human error lines to stdout. Human and CI renderers may
use stderr or an explicit sink policy for diagnostics, but the policy must be
tested. Live human redraw must coordinate with all other diagnostic writes.

Run the complete workspace verification gate after integration.

## Acceptance Criteria

**Scenario:** Auto mode selects human output locally

- **Given:** An interactive non-CI TTY
- **When:** The user runs seqlane with output auto
- **Then:** The CLI selects the human renderer

**Scenario:** Auto mode selects CI output

- **Given:** CI or a non-TTY environment
- **When:** The user runs seqlane with output auto
- **Then:** The CLI selects append-only CI output

**Scenario:** Unsupported terminal capabilities degrade safely

- **Given:** A terminal without ANSI or Unicode support, or a resize event
- **When:** The CLI runs human output
- **Then:** The selected renderer updates capabilities and emits safe output

**Scenario:** Explicit JSON mode is clean

- **Given:** The user selects output json
- **When:** Runner events arrive
- **Then:** Stdout contains only the JSON event stream

**Scenario:** Execution status is authoritative

- **Given:** A successful or failed runner result and a renderer write failure
- **When:** The CLI finishes
- **Then:** The runner result determines the process exit status

**Scenario:** Package boundaries remain enforced

- **Given:** All changed package manifests and imports
- **When:** Boundary checks run
- **Then:** Core and runtime contain no terminal renderer dependency, and cross-package imports use declared exports

**Scenario:** Workspace gates pass

- **Given:** The completed spec.seqlane-execution-output-package implementation
- **When:** The standard workspace gate runs
- **Then:** install, typecheck, tests, lint, build, formatting, Nx sync, and diff checks pass

## Source and current owners

- [adr.dedicated-seqlane-output-package — Isolate Seqlane Execution Output](../adrs/2026-09-02-dedicated-seqlane-output-package.md)
- [spec.seqlane-execution-output-package — Seqlane Execution Output Package](../specs/2026-09-02-seqlane-execution-output-package.md)
- [rfc.execution-observability-and-debugging — Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [spec.work-run-invocation-identity-model — Work, Run, and Invocation Identity Model](../specs/2026-09-02-work-run-invocation-identity-model.md)

## Traceability

- [spec.seqlane-execution-output-package](../specs/2026-09-02-seqlane-execution-output-package.md)
