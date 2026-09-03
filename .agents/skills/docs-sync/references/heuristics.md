# Doc Sync Heuristics

## Fast Mapping

- file in `apps/<name>/...` -> check `apps/<name>/README.md`, local `docs/`, then nearest parent docs
- file in `libs/<name>/...` -> check `libs/<name>/README.md`, `libs/<name>/AGENTS.md`, then nearest parent docs
- file in `services/<name>/...` -> check `services/<name>/README.md`, local runbooks, then nearest parent docs
- file in `.github/workflows/...` -> check `.github/workflows/README.md`, contributor docs, or root workflow docs
- file in `docs/...` -> update the touched doc and nearby index pages if navigation depends on them
- file in `skills/<name>/...` or another agent-guidance directory -> check that skill or guidance doc plus nearby `AGENTS.md`
- file in infra directories like `terraform/...`, `helm/...`, or `k8s/...` -> check nearest module docs, ops docs, and runbooks
- change to shared architecture, ownership boundaries, service topology, data flow, adapter contracts, or major runtime dependencies -> check architecture docs
- root-level config or tooling changes -> check root `README.md`, root `AGENTS.md`, contributor docs, or setup docs

## Common Fallback Doc Names

Prefer the closest file that already exists, especially:

- `README.md`
- `AGENTS.md`
- `CONTRIBUTING.md`
- `architecture.md`
- `design.md`
- `runbook.md`
- `operations.md`
- `usage.md`
- `how-to.md`

Also check same-topic docs under local `docs/` directories before falling back to workspace-root docs.

## Strong Signals A Doc Edit Is Needed

- added or removed command, flag, env var, package, endpoint, route, or workflow step
- changed setup instructions, auth assumptions, port selection, or runtime defaults
- changed shape of a published contract, config, schema, generated output, or example payload
- changed how contributors should extend, run, test, release, or troubleshoot a package
- changed agent-facing instructions, automation behavior, or repo-specific guidance
- changed architecture, ownership, or service or data flow readers need to understand

## Weak Signals

- internal helper extraction
- rename behind an unchanged external interface
- formatting-only cleanup
- test-only hardening for existing behavior
- type-only cleanup with no workflow or contract impact

## Good Short Reasons For No Doc Change

- `internal refactor only; local docs unchanged`
- `test-only change; no supported behavior changed`
- `format/type cleanup only; no doc-visible impact`
