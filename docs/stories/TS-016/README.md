# TS-016 Implementation Stories

1. [TS-016-00 — Create the canonical execution-events package](TS-016-00-canonical-execution-events-package.md)
2. [TS-016-01 — Emit sanitized Plan snapshots from the runner](TS-016-01-runtime-plan-snapshot-events.md)
3. [TS-016-02 — Fan out events to independent CLI consumers](TS-016-02-cli-consumer-fanout.md)
4. [TS-016-03 — Render static Plans and live invocations in Studio](TS-016-03-studio-static-plan-projection.md)
5. [TS-016-04 — Record and replay canonical execution streams](TS-016-04-recording-and-replay.md)
6. [TS-016-05 — Verify boundaries and complete the migration](TS-016-05-boundary-verification-and-documentation.md)

## Delivery order

Stories are ordered by dependency. TS-016-00 is the contract foundation;
TS-016-01 through TS-016-04 can only consume it. TS-016-05 is the final
cross-package and end-to-end checkpoint.

## Deferred

OpenTelemetry exporters, CloudEvents transport, external brokers, persistent
event storage, workflow resumption, raw executor transcript persistence, and
third-party consumer discovery remain outside TS-016.
