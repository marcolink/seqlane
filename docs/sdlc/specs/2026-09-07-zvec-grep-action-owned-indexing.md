---
id: spec.zvec-grep-action-owned-indexing
title: zvec-grep Action-Owned Package Resolution and Indexing
status: active
owners:
  - core
created: 2026-09-07
updated: 2026-09-11
upstream:
  - adr.seqlane-action-library-boundary
  - adr.runner-built-action-bundles
  - task.migrate-service-actions-to-workspace-structure
supersedes: []
---

# zvec-grep Action-Owned Package Resolution and Indexing

## Summary

The `actions/zvec-grep-server` JavaScript Action owns resolution of the
requested `@zvec/zvec-grep` version, indexing of its working directory, and
MCP service startup. A workflow caller invokes the Action only; it does not
install, resolve, or index zvec-grep separately.

## Goals

- Make the Action self-contained for package resolution and indexing.
- Preserve the existing service inputs, outputs, readiness check, and cleanup.
- Keep the reviewed project and the indexed/served project identical.
- Preserve the explicit source-file allowlist and unsafe-file exclusions.
- Allow callers to tune embedding, maximum file size, and additive
  include globs without weakening immutable unsafe-file exclusions.
- Make model-cache use an explicit boolean Action input.

## Non-goals

- Changing the zvec-grep package, server protocol, MCP URL, or process
  lifecycle contract.
- Adding zvec-grep as a workspace dependency.
- Weakening the immutable unsafe-file exclusions.

## Terminology

- **Project**: the Action `working-directory`; it is both indexed and served.
- **Package spec**: `@zvec/zvec-grep@<version>` built from the required
  `version` input.
- **Unsafe files**: secrets, private material, vendor content, generated
  output, and the other excluded paths in the index policy below.

## Requirements

### requirement-action-lifecycle

The Action validates and canonicalizes `listen` before any command or process
spawn. It then performs these foreground steps in order:

1. resolve `@zvec/zvec-grep` at the supplied version through the selected
   package manager's supported `dlx <package-spec> version` invocation;
2. index the `working-directory` project with the exact supported file policy;
3. spawn the zvec-grep MCP server;
4. perform its existing readiness check.

If resolution or indexing fails, the server is not spawned. If server startup
or readiness fails after spawning, existing process-group cleanup remains
mandatory.

### requirement-indexed-project

`working-directory` is the project passed explicitly to the zvec-grep index
command. It is not used as the package-manager process working directory. The
resolve, index, server, and readiness commands run from the trusted shipped
Action directory derived from the bundled module's separate process-anchor
path, so package-manager configuration is not read from the reviewed project.
The Action must not index a different implicit path.

### requirement-listen

`listen` must contain a hostname and an explicit non-default HTTP port. The
Action parses it once before resolve, index, server, or readiness execution,
then uses the canonical host-and-port form for the server command and its MCP
URL output. Bracketed IPv6 addresses are supported.

### requirement-file-policy

Indexing uses fixed `direct` mode, `local/potion-code-16m-v2`, hidden files,
and a maximum file size of `1M` by default. The optional `embedding` and
`max-filesize` inputs are passed as the corresponding index argument values.
The allowlist is exactly:

`*.ts`, `*.tsx`, `*.mts`, `*.cts`, `*.js`, `*.jsx`, `*.json`, `*.yaml`,
`*.yml`, `*.md`, `*.css`, `*.html`, `*.sh`, and `.github/**`.

The exclusions remain exactly:

`**/node_modules/**`, `**/dist/**`, `**/build/**`, `**/coverage/**`,
`**/.cache/**`, `**/.next/**`, `**/vendor/**`, `**/.env`, `**/.env.*`,
`**/.envrc`, `**/.npmrc`, `**/id_*`, `**/*.pem`, `**/*.key`, `**/*.p8`,
`**/*.p12`, `**/*.pfx`, `**/*.crt`, `**/*.cer`, `**/*.der`, `**/*.csr`,
`**/secrets/**`, `**/private/**`, `**/credentials/**`, `**/*secret*`,
`**/*credential*`, `**/*token*`, `**/*service-account*`,
`**/*service_account*`, `**/*auth*.json`, `**/*auth*.yaml`, and
`**/*auth*.yml`.

The optional `glob` input is newline-delimited. Each non-empty value is sent
as a separate `--glob <value>` pair after the built-in allowlist and before
all immutable exclusions. It may add source types, but cannot weaken any
immutable exclusion.

### requirement-environment

Resolve, index, server, and readiness commands receive the complete inherited
process environment with `ZVEC_GREP_HOME` overridden. `model-cache` is a
boolean Action input that defaults to `true`. When true, the Action sets
`ZVEC_GREP_MODEL_CACHE` to its runner-temp `zvec-grep-model-cache` path. When
false, it omits `ZVEC_GREP_MODEL_CACHE` entirely, including an inherited
value. `ZVEC_GREP_HOME` is always set. Boolean parsing uses the Action toolkit
and invalid values fail at the input boundary. The former path-valued
`model-cache` input is not supported.

### requirement-caller

Workflow callers have no standalone zvec-grep install or index command. The
review workflow invokes the Action with `working-directory` set to the
reviewed project and continues to consume the existing `mcp-url` and
`log-path` outputs.

## Detailed design or contracts

The Action constructs argument arrays, not shell command strings. The resolve
command is a foreground `pnpm dlx <package-spec> version`, followed by
`pnpm dlx <package-spec> index <project> ...` (or equivalent selected
package-manager invocations). All four commands run with the trusted shipped
Action directory as `cwd`; the reviewed project is passed only as the explicit
index argument. The server command remains `dlx <package-spec> server run
--listen <canonical-listen>`, and readiness remains `dlx <package-spec> server
status --check-ready --home <home>`.

The index command always passes `--mode direct`, `--hidden`, and the built-in
allowlist/exclusion sequence. It passes `embedding`, `max-filesize`, and each
`glob` value as separate argument-array entries.

`src/main.ts` is the Action adapter: it reads Action inputs, delegates the
zvec-grep lifecycle to a private Action module, and writes outputs or reports
failures. The private module owns resolve, index, server startup, readiness,
and process cleanup orchestration.

The consuming workflow installs and builds only its trusted Seqlane source
checkout. The runner-built Action bundle contains its runtime dependencies,
while zvec-grep is resolved by the package manager at the requested version at
execution time. The generated main and post bundles are loadable ESM modules and use a
CommonJS bridge for dependencies that require `require` at runtime.

## Failure and edge cases

- Invalid working directories, invalid boolean `model-cache`, and invalid
  timeout/listen inputs fail before service startup. Invalid listen input fails
  before package resolution or indexing.
- The resolve or index command failure fails the Action and leaves no
  spawned service to clean up.
- A service spawn, readiness, or state-save failure retains existing cleanup
  behavior and output contract.
- Unsafe files remain unindexed even when they match an allowlisted extension.

## Migration

Remove the review workflow's standalone index step. Set the zvec Action
`working-directory` to the reviewed project. Existing callers that provide a
project directory receive indexing as part of Action startup.

## Verification

- Unit-test pure command construction, defaults and overrides, exact file
  policy and glob ordering, representative sensitive-file exclusions,
  immutable exclusions, and zvec home/model-cache environment construction.
- Run focused Action tests, typecheck, bundle build/loading checks, workflow and
  metadata parsing, and `actionlint` when available.
- Run test mapping and SDLC index/validation checks.

## Acceptance criteria

- The Action resolves the supplied package version, indexes its working
  directory, then starts and readiness-checks the server in that order.
- Package-manager commands run from the trusted shipped Action directory and
  receive the reviewed project only as the index argument.
- Listen validation happens before resolve/index/spawn and the canonical listen
  form is used for server arguments and the MCP URL output.
- Index failure prevents server spawn.
- The exact allowlist and exclusions above are preserved.
- Index option defaults and overrides are passed as argument arrays, additive
  globs precede immutable exclusions, and model-cache false omits its
  environment variable.
- Sensitive JSON/YAML configuration, service-account, token, certificate, and
  private-key filenames remain unindexed even when they match an allowlisted
  extension.
- The Action entrypoint delegates zvec lifecycle orchestration to a private
  Action module.
- Existing service cleanup and `mcp-url`/`log-path` outputs remain intact.
- The review workflow has no standalone zvec-grep index command and invokes
  the Action against `review-target`.

## Traceability

- Packaging: [adr.runner-built-action-bundles](../adrs/2026-09-11-runner-built-action-bundles.md)

- [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- [task.migrate-service-actions-to-workspace-structure](../tasks/2026-09-07-migrate-service-actions-to-workspace-structure.md)
- [task.adopt-zvec-grep-action-owned-indexing](../tasks/2026-09-07-adopt-zvec-grep-action-owned-indexing.md)
- [task.configure-zvec-grep-action-indexing](../tasks/2026-09-07-configure-zvec-grep-action-indexing.md)
- [task.harden-zvec-grep-index-policy-and-entrypoint](../tasks/2026-09-07-harden-zvec-grep-index-policy-and-entrypoint.md)
