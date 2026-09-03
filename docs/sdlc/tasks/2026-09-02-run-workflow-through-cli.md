---
id: task.run-workflow-through-cli
title: Run a selected workflow through the installed and development CLI
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.dedicated-runner-process
supersedes: []
---

# Run a selected workflow through the installed and development CLI

> Migrated from implementation story `TS-002-08`.

## Use Case
**As a** Seqlane workflow operator, **I want to** invoke `seqlane run` from an installed CLI or a repository checkout, **so that** I can start an isolated workflow run and see its outcome without calling internal TypeScript APIs.

## Acceptance Criteria
**Scenario:** *Installed CLI starts one selected workflow*
- **Given:** `seqlane` has been built and installed with its `seqlane` executable
- **and Given:** I supply a resolvable workflow reference, JSON input, and an OpenCode connection configuration
- **When:** I run `seqlane run <workflow>` with the documented required options
- **Then:** oclif parses the command, the CLI creates one `RunRequest`, launches one foreground runner, renders the structured lifecycle projection, and exits with the runner outcome status (`0`, `1`, or `130`)

**Scenario:** *Development CLI runs source commands without a prior build*
- **Given:** I have installed workspace dependencies in a repository checkout
- **and Given:** the CLI has not been built after my latest source change
- **When:** I invoke the documented development entry point with `run <workflow>`
- **Then:** it discovers and executes `src/commands` in oclif development mode, auto-transpiles TypeScript without requiring `dist`, preserves the installed command's parsing, runner, rendering, and exit-status behaviour, and shows development diagnostics on failure

**Scenario:** *Invalid command input does not start a runner*
- **Given:** I omit a required workflow or connection option, or provide invalid JSON input
- **When:** I invoke `seqlane run`
- **Then:** oclif reports a command-validation error and exits non-zero without forking a runner or importing a workflow

**Scenario:** *The command remains a supervisor*
- **Given:** `seqlane run` accepts a valid request
- **When:** the selected workflow succeeds, fails, or is cancelled
- **Then:** the command awaits the runner result before returning, uses only Seqlane-owned protocol data and rendered events, and never imports the workflow for execution or owns Mastra, executor, OpenCode, or run-scoped state

## Technical Details
Use the oclif 4 ESM starter pattern already selected by `@oclif/core@4.13.5`:

```text
apps/seqlane-cli/
  bin/run.js       # installed production entry; execute({ dir: import.meta.url })
  bin/dev.js       # source entry; execute({ development: true, dir: import.meta.url })
  src/commands/run.ts
```

- Add the package `bin` mapping for `seqlane`, and oclif configuration that discovers production commands from `./dist/commands`.
- Add a documented workspace development command that runs `bin/dev.js`; follow the oclif ESM starter's TypeScript loader (`ts-node/esm`) or an equivalent supported loader. Development mode must use source commands and require no build.
- Implement `src/commands/run.ts` as a default oclif `Command` export using static args/flags and `await this.parse(...)`. Await runner supervision inside `run()`; oclif documents that un-awaited work can be terminated after `Command.run` resolves.
- Keep workflow discovery out of this command's first implementation. Until adr.repository-user-workflow-discovery-and-composition is implemented, accept an explicit, resolvable workflow reference and convert it to the existing `WorkflowReference`; do not silently invent name-resolution rules.
- Command options must provide the existing `RunRequest` inputs: workflow reference, JSON input, and OpenCode URL. The runner remains responsible for import, Plan construction, validation, and execution.
- Cover installed and development entry points with command-level tests, including real-child success, normalized failure, cancellation, CLI validation before fork, projection output, and exit statuses.

From the repository root, the development entry point is:

```bash
pnpm exec nx build seqlane-runtime && pnpm exec nx build seqlane-fixtures
./apps/seqlane-cli/bin/dev.js run @seqlane/fixtures/renovate-workflow#createRenovatePlan \
  --input '{"dependency":"some-package","fromVersion":"1.0.0","toVersion":"2.0.0","failure":"Tests fail after update"}' \
  --opencode-url http://127.0.0.1:1234
```

The production entry point uses the same arguments after `pnpm exec nx build seqlane-cli`; an installed package exposes it as `seqlane run <module-specifier>#<export-name>`.

## Out of Scope
- Repository/user workflow discovery, `list`, and `plan` commands; adr.repository-user-workflow-discovery-and-composition owns discovery and ambiguity rules.
- Managed OpenCode startup, shutdown, or real-server integration.
- A persistent runner, daemon, detached/background execution, or interactive runtime protocol.
- Publishing, installers, and release packaging beyond the local executable entry points.

## Source
- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [adr.dedicated-runner-process — Execute Each Seqlane Run in a Dedicated Node Process](../adrs/2026-09-02-dedicated-runner-process.md)
- [adr.repository-user-workflow-discovery-and-composition — Support Repository and User Scoped Composition Using Ordinary TypeScript](../adrs/2026-09-02-repository-user-workflow-discovery-and-composition.md)
- [oclif Commands](https://oclif.io/docs/commands)
- [oclif Templates: bin scripts](https://oclif.io/docs/templates#bin-scripts)
- [oclif CLI configuration](https://oclif.io/docs/configuring_your_cli)
- [oclif ESM CLI starter template](https://github.com/oclif/oclif/tree/main/templates/cli/esm)

## Traceability

- [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)
