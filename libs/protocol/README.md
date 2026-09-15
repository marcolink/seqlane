# @seqlane/protocol

Public, executor-neutral contracts for serialized Seqlane execution and runner
protocol messages.

The package owns the canonical `SeqlaneExecutionEvent` union, runner commands,
event metadata, JSON encoding, and sanitized Plan snapshots. It reuses the
core-owned JSON schemas and guard for JSON values. Plan
snapshots preserve model selections under isolated and branch session policies;
reuse policies remain model-free. Public protocol types are derived from
package-owned canonical Zod schemas so each wire contract has one authoritative
definition.

The package has no dependency on Mastra, executors, Studio, terminal output,
OpenTelemetry, CloudEvents, or consumer lifecycle management. Runtime code
emits protocol events, while each application surface owns its own dispatch and
recording lifecycle.
