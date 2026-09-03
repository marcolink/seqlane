---
id: task.runtime-execution-profiles
title: Add Runtime Agent Profiles and Configuration
status: planned
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.runtime-resolved-execution-profiles
supersedes: []
---

# Add Runtime Agent Profiles and Configuration

> Migrated from implementation story `TS-018-01`.

## User outcome

As a runtime operator, I can define a private agent profile registry that
maps logical workflow keys to targets for the adapter selected for the Run.

## Scope

- Define the private runtime configuration contract.
- Add the optional CLI `--config <path>` selection.
- Discover only `seqlane.config.json` and `seqlane.config.ts` from the CLI
  with Cosmiconfig's asynchronous `search` API.
- Pass only the absolute config path over IPC.
- Load and validate the agent profile registry.
- Keep profile keys exact and case-sensitive.
- Support runtime-specific profile mappings.
- Do not add an adapter discriminator to agent entries; use the Run's existing
  adapter selection.
- Keep the OpenCode configuration block private and adapter-owned.
- Reject malformed configuration and conflicting entries.
- Reject unsupported configuration formats and TypeScript modules without a
  default export.

## Out of scope

- Workflow authoring fields.
- Live gateway/model checks.
- OpenCode prompt execution.
- Profile overlays.
- Multi-session execution.

## Implementation notes

The profile registry must not cross public runner IPC. The selected private
runtime reference, including the selected config path, resolves configuration
inside the runner process. Use the
exact pinned OpenCode schema in the private adapter package. Do not duplicate
that schema in core. Cosmiconfig search places must be explicit; do not use
its default YAML, RC, JavaScript, or package-property search places. The
runner loads and validates the selected path; the CLI does not send config
contents over IPC.

## Acceptance criteria

**Scenario:** *A runtime resolves a configured profile*

- **Given:** The runtime configuration contains a profile key and target
- **When:** The runtime resolves the key
- **Then:** It returns the private target and effective configuration source

**Scenario:** *Runtime configurations differ*

- **Given:** Two runtime configurations use the same profile key
- **When:** Each runtime resolves the key
- **Then:** Each runtime can return a different target without changing workflow source

**Scenario:** *An unknown profile is requested*

- **Given:** A workflow references a key absent from the registry
- **When:** Runtime resolution runs
- **Then:** Resolution returns a typed missing-profile issue

**Scenario:** *Only supported config files are discovered*

- **Given:** A directory contains `seqlane.config.json`, `seqlane.config.ts`, and an unsupported config file
- **When:** CLI configuration discovery runs
- **Then:** Only the two Seqlane config file names are considered

**Scenario:** *A TypeScript config exports the object*

- **Given:** `seqlane.config.ts` has a default export containing valid config
- **When:** Runner configuration loading runs
- **Then:** Cosmiconfig loads the default export and schema validation runs

**Scenario:** *The CLI passes only a config path*

- **Given:** The CLI selects a valid runtime config
- **When:** It starts the runner
- **Then:** IPC contains the absolute path but no parsed config or secret

**Scenario:** *Secrets remain private*

- **Given:** The runtime configuration contains credentials or secret references
- **When:** The runtime loads or resolves configuration
- **Then:** Secrets do not enter workflow definitions, Plans, runner commands, events, or diagnostics

## Source

- [adr.runtime-resolved-execution-profiles](../adrs/2026-09-02-runtime-resolved-execution-profiles.md)
- [spec.runtime-resolved-execution-profiles](../specs/2026-09-02-runtime-resolved-execution-profiles.md)

## Traceability

- [spec.runtime-resolved-execution-profiles](../specs/2026-09-02-runtime-resolved-execution-profiles.md)
