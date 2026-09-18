---
id: spec.standalone-cli-runs
title: Standalone CLI Run Contract
status: active
owners:
  - core
created: 2026-09-16
updated: 2026-09-16
upstream:
  - prd.seqlane-on-mastra
  - rfc.mastra-runtime-and-operational-foundation
  - adr.standalone-cli-runs
supersedes: []
---

# Standalone CLI Run Contract

## Summary

`seqlane run` executes one explicit workflow entrypoint through Mastra, returns
its result, and exits. It requires no app, catalog, operational server, or
Seqlane configuration file. This specification owns standalone execution.
Existing output specifications own terminal rendering and final result schemas.

## Goals

- Execute local TypeScript, JavaScript, and installed package entrypoints.
- Support ordinary imports without catalog discovery.
- Make adapter selection sufficient for adapter startup and connection.
- Preserve workflow model choices and adapter permission configuration.
- Keep Seqlane run state in memory and release owned resources.

## Non-goals

- Seqlane apps, `serve`, Studio, MCP, and catalog discovery redesign.
- Untrusted-code isolation or a Seqlane permission system.
- Persistent history, logs, recording, result files, or resumable runs.
- Automatic dependency installation, package builds, or watch mode.
- New output formats, model overrides, or custom adapter endpoint flags.

## Terminology

- **Entrypoint:** the module and export selected by the command argument.
- **Workflow:** an authored Seqlane workflow definition.
- **Caller directory:** the process working directory at command invocation.
- **Execution workspace:** the directory supplied to workspace-bound tasks.
- **Owned resource:** a process, connection, or temporary resource created by
  this command and tracked for cleanup.

## Requirements

### requirement-explicit-entrypoint

The command accepts these forms:

| Argument | Selected export |
| --- | --- |
| `./review.ts`, `review.ts`, `/absolute/review.mjs`, `file:///absolute/review.mjs` | Default export of a local file |
| `./review.ts#review` | Named export of a local file |
| `@acme/workflows/review` | Default export of an installed package subpath |
| `@acme/workflows#review` | Named export of an installed package |

Local entrypoints support `.ts`, `.mts`, `.js`, and `.mjs`. The suffix applies
before an optional `#export`. An omitted selector means `default`. Empty
selectors, missing exports, unsupported extensions, and directory arguments
produce command errors. The CLI never chooses an arbitrary export.

Explicit relative paths, absolute paths, and file URLs identify files. A bare
filename such as `review.ts` also identifies a file. Scoped package references
and other valid bare module specifiers identify packages. Unprefixed paths such
as `examples/review.ts` require `./` to distinguish them from package subpaths.
Reference interpretation never changes because a same-named local file exists.

Packages must expose an ESM-compatible workflow entrypoint through their public
exports. A TypeScript project is not itself a runnable workflow. Select its
source entrypoint or a compiled package export. Remote URLs are unsupported.

`repository:name`, `user:name`, and catalog aliases are not run references.
No descriptor directory or unrelated workflow module is read or imported.

### requirement-module-resolution

Relative file arguments resolve from the caller directory. Bare package
arguments resolve with ESM import conditions from the caller's nearest package
context. They must not resolve against the Seqlane installation's dependencies.
Without a package manifest, use the caller directory as the resolution base.

Transitive relative imports resolve from their importing modules. Transitive
package imports use the importing package's dependency context. Respect package
exports, including workspace-linked packages. A package's internal source and
`dist` paths are not substitutes for its public exports.

Missing dependencies produce an actionable command error. The CLI must not
install dependencies, run package scripts, or build a package implicitly.

### requirement-typescript-loading

Source TypeScript uses project-aware transpilation without a separate build.
The supported baseline includes erasable types, enums, ordinary module imports,
and the nearest applicable `tsconfig.json` with relative `extends`, `baseUrl`,
and `paths`. Relative aliases resolve from the configuration that declares them.
A `.js` source import can resolve to its `.ts` implementation under TypeScript
resolution rules. Published package imports still follow package exports.

The execution format is ESM. Typechecking remains a separate author operation.
JSX, CommonJS source entrypoints, custom transformers, and compiler plugins are
outside this initial contract. Unsupported required compiler behavior must
produce an actionable error rather than silently changing execution semantics.

The loader must not emit project build output or a persistent transpilation
cache. The implementation task selects and verifies the loader mechanism.
These requirements do not select a new dependency.

### requirement-workflow-export

The selected export must be an authored Seqlane workflow definition. Files and
packages use the same validation and compilation path. Raw Plans and arbitrary
input-dependent Plan factories are not public run entrypoints.

The definition is independent of run input. Input enters workflow execution,
including declared branching and repeat behavior. It does not select which
module or workflow graph the CLI loads.

Imports are normal trusted Node.js execution. Validation does not prevent
module side effects, dynamic imports, filesystem access, or network access.
The command must not claim otherwise.

### requirement-input-workspace-environment

`--input <json>` and `--input-file <path>` are mutually exclusive.
`--input-file -` reads JSON from stdin. Stdin is never consumed implicitly.
An input file path resolves from the caller directory. Each explicit input
source has a 1 MiB UTF-8 limit and must contain one valid JSON value.

With no input flag, validate `{}` against the workflow input schema. Apply
schema defaults and transformations before task execution. A workflow that
requires missing fields fails with an actionable validation error.

The execution workspace defaults to the caller directory. `--workspace <path>`
overrides it and resolves relative to that directory. Validate that it exists
and is a directory. Do not change module resolution when the workspace changes.

The command inherits the caller's environment. It does not automatically load
`.env` files. Adapter-native configuration loading remains adapter-owned.
The execution workspace does not restrict trusted module access or establish
a sandbox.

### requirement-adapter-lifecycle

Agent execution requires `--adapter <id>`. Unknown identifiers produce an
argument error. Missing selection fails when an agent is requested.
Deterministic workflows require neither an
adapter nor a model. Even with an explicit valid adapter flag, a deterministic
workflow must not start an adapter process or make a model call.

Acquire the adapter lazily at the `context.runAgent()` boundary. Do not add a
public or private task discriminator, inspect function bodies, or infer agent
use from a session declaration. Custom tasks can request agents through the
same boundary. Concurrent requests share one run-owned acquisition.

For an installed and authenticated OpenCode adapter, this is sufficient:

```sh
seqlane run ./myworkflow.ts --adapter opencode
```

The example assumes the input schema accepts `{}`. Package entrypoints have
the same contract. Seqlane configuration, endpoint URLs, and prestarted services
are not prerequisites.

The selected integration locates its executable and reads its normal
configuration and authentication. It starts a private service when required,
waits for readiness, connects, and records ownership before the agent invocation.
It does not silently attach to an arbitrary service on a default port.

Startup and shutdown use finite bounds. Failed startup releases resources
already acquired. Concurrent runs must not collide on ports or temporary paths.
Missing executables or authentication produce adapter-specific setup guidance.
The command does not install executables, launch login, or edit credentials.

Permissions remain defined by the adapter configuration. Seqlane must not
silently grant additional permissions or bypass an approval requirement.
A required approval that cannot complete non-interactively fails clearly.

### requirement-model-compatibility

Each new agent session declares a model or inherits a workflow-level model default.
Session reuse and branches preserve the existing pinned-model inheritance rules.
Missing model declarations fail validation. The CLI provides no model override
and does not use an adapter's implicit model default.

Resolve declared or inherited models when an agent is requested. Reject missing
selections before adapter startup. After lazy acquisition, check model
availability, explicit model settings, and required capabilities before the
agent invocation when discovery provides sufficient information.
Unsupported choices fail with the session, model, adapter, and reason.
Do not substitute a model, drop an explicit setting, or choose another adapter.

When availability cannot be established beforehand, enforce the same contract
at invocation. Distinguish unavailable models from authentication, connection,
and transient provider failures. Accepted model choices can limit adapter
compatibility without changing the executor-neutral workflow structure.

### requirement-execution-lifecycle

Use Mastra as the sole generic runtime with state held in memory. Standalone
execution must not start a Seqlane HTTP server or use an operational client.
Adapter-local transports are permitted and remain distinct from a Seqlane host.

Validate argument syntax, entrypoint, authored definition, Plan, input, and
workspace before adapter startup. Capability checks that need a live adapter
occur after lazy startup and before the agent invocation where possible.
Earlier deterministic work can complete before an adapter or model error occurs.

SIGINT and SIGTERM request cancellation through Mastra and active adapter or
process operations. Cleanup runs after success, failure, cancellation, and
partial startup. Use bounded shutdown and terminate only owned child processes.
A second interruption can force owned-process termination. Arbitrary crashes,
SIGKILL, and power loss cannot guarantee cleanup.

When the dedicated worker loses its CLI supervisor IPC connection, it must
request the same cancellation path, close owned runtime and adapter resources,
then terminate after cleanup. This protects against an abruptly terminated
supervisor without changing the runner IPC contract.

Preserve existing declared task timeout and retry semantics. This deliverable
adds no command-wide timeout flag and no implicit whole-workflow retry.
Cleanup failures remain secondary to the primary outcome under the machine
output contract. Restore the terminal and remove signal listeners.

### requirement-no-persistence

Seqlane must not create or update durable databases, run history, recordings,
logs, saved results, session indexes, transpilation caches, or artifact stores.
Do not write `.seqlane/mastra.db`, event files, or `GITHUB_STEP_SUMMARY`.
Mastra operational state for the command remains in memory.

Temporary implementation resources must be bounded, tracked, and removed during
normal cleanup. They must not become retained diagnostic or resume artifacts.
Adapter-managed files follow adapter behavior. Workflow-created files remain
intentional outputs. Do not delete either category as Seqlane run history.
User shell redirection of stdout or stderr is outside this persistence policy.

### requirement-output-and-errors

Preserve `spec.run-terminal-rendering` and the final-result, error, and exit
contracts in `spec.run-machine-output`. Human output remains passive. CI output
remains append-only. `--json` emits one validated final result without progress.
Adapter and imported-module stdout must not corrupt final JSON stdout. Capture
incidental module or child output through bounded diagnostic handling. Suppress
incidental logs in normal JSON output. Explicit debug output can use stderr.

Normal success exits `0`, failure exits `1`, and cancellation exits `130`,
subject to the existing Oclif usage and serialization precedence. Preserve typed
causes without default stack traces or credential disclosure.

## Detailed design or contracts

The standalone path has these stages:

1. Parse arguments and select output behavior.
2. Resolve and import one entrypoint and its dependencies.
3. Validate the workflow, input, workspace, and compiled Plan.
4. Prepare the selected adapter only when agent work requires it.
5. Check available model and capability information.
6. Execute the workflow through the private Mastra integration.
7. Normalize the authoritative result and release owned resources.
8. Emit the final result and exit.

`--dry` retains its planning-only purpose for explicit entrypoints. It compiles
and displays the Plan without tasks, adapters, models, servers, or persistence.
It does not claim that import-time application code is side-effect-free.

## Failure and edge cases

- An unrelated broken catalog or workflow cannot prevent a direct run.
- A helper import can fail before workflow export validation.
- Import-time side effects can occur even when later validation fails.
- A package and workspace outside the Seqlane checkout must resolve correctly.
- An adapter can reject a model at invocation despite successful discovery.
- A workflow can leave intentional partial workspace changes after failure.
- An adapter can retain native sessions even though Seqlane retains no history.
- Cleanup must never terminate another run's adapter service.

## Migration

Replace the host-backed run path without retaining a second execution engine.
Remove `--runtime`, `--server-url`, `--hostname`, `--port`, `--storage-url`,
`--repository-root`, `--user-root`, and `--record` from `run`. Remove its catalog
name resolution, private configuration-environment dependency, durable storage,
and automatic GitHub summary writes. No compatibility aliases remain.

Preserve shared components required by hosted commands. Existing replay can
consume previously supplied files, but this deliverable does not generate them.
Update CLI help, examples, hooks, and internal run callers in the same delivery.
Custom adapter endpoints and later app execution need separate contracts.

## Verification

Test observable behavior through the compiled CLI and focused runtime tests:

| Area | Required evidence |
| --- | --- |
| Entrypoints | TS/JS, default/named exports, package roots/subpaths, invalid references |
| Imports | Local helpers, package dependencies, alias/extends resolution, unrelated import sentinel |
| External caller | Package resolution outside the Seqlane installation and changed workspace |
| Validation | Malformed JSON, schema defaults, missing input, invalid exports, missing dependencies |
| Input streams | Explicit stdin, bounded files, conflicting flags, no implicit stdin read |
| Adapter | No-config startup, readiness failure, missing executable/authentication, concurrent ownership |
| Models | Missing, unavailable, incompatible settings, unknown availability, no substitution |
| Deterministic work | Zero adapter processes and zero model calls, including custom tasks and an explicit valid adapter flag |
| Lifecycle | Success, failure, both signals, partial startup, bounded cleanup, foreign process survives |
| Persistence | No database, recording, summary, history, retained temporary output, or disk cache |
| Output | Passive human/CI parity, clean JSON despite imported logging, exact false-like results |
| Boundaries | No Seqlane listener, operational-client dependency, public Mastra types, or `/ee/` imports |

Use filesystem snapshots with workflow outputs and adapter-owned files explicitly
identified. A temporary database that is later deleted does not satisfy the
in-memory state requirement. Use a deterministic local workflow to prove the
absence of a Seqlane listener without adapter transport ambiguity.

## Acceptance criteria

All requirement sections above pass their mapped tests. The installed CLI can
execute a file and an installed package with the same no-config adapter setup.
No unrelated catalog import occurs. No Seqlane persistence remains after exit.
Existing hosted command tests and output contracts continue to pass.

## Delivery state

Active target contract. Implementation is pending under
`task.deliver-standalone-cli-runs`. Current source still exposes host, catalog,
runtime-profile, and recording behavior. This specification is not evidence of
delivered runtime behavior.

## Traceability

- [prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md#requirement-standalone-cli-runs)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
- [adr.standalone-cli-runs](../adrs/2026-09-16-standalone-cli-runs.md)
- [Operational integration](./2026-09-03-mastra-runtime-and-operational-integration.md)
- [Run terminal rendering](./2026-09-15-run-terminal-rendering.md)
- [Run machine output](./2026-09-15-run-machine-output.md)
- [Delivery task](../tasks/2026-09-16-deliver-standalone-cli-runs.md)
