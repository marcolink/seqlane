# @seqlane/protocol

Executor-neutral contracts for serialized Seqlane execution and runner protocol
messages. This package is a public registry dependency of `seqlane`, but it is
not a supported workflow-authoring API.

The package owns the canonical `SeqlaneExecutionEvent` union, runner commands,
event metadata, JSON encoding, operational DTOs, and sanitized Plan snapshots.
It reuses the core-owned JSON schemas and guard for JSON values. Plan
snapshots preserve model selections under isolated and fork session policies;
reuse policies remain model-free. Public protocol types are derived from
package-owned canonical Zod schemas so each wire contract has one authoritative
definition.

Public wire values contain no Effect runtime state or concrete adapter types.
The package has no execution, storage, telemetry, or presentation dependency.
Runtime code emits protocol events; each application surface owns its dispatch
and recording lifecycle. Canonical observations retain complete available
model, tool, skill, request, response, usage, cost, timing, and correlation data.
