# @seqlane/events

Public, executor-neutral contracts for serialized Seqlane execution events.

The package owns the canonical `SeqlaneExecutionEvent` union, event metadata,
JSON guards and encoding, sanitized Plan snapshots, and the generic consumer
contract. Public event types are derived from the package-owned canonical Zod
schema so the runtime contract has one authoritative definition. It has no
dependency on Mastra, executors, Studio, terminal output, OpenTelemetry, or
CloudEvents.

Consumers receive events through `SeqlaneExecutionEventConsumer` and must
preserve the event order supplied by the dispatcher.

Validation and encode/decode helpers are schema-backed so CLI recording/replay,
Studio transport, and other consumers can reject malformed event payloads at
the package boundary.
