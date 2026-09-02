# TS-019 Implementation Stories

1. [TS-019-00 — Add the private Effect workflow surface](TS-019-00-effect-workflow-surface.md)
2. [TS-019-01 — Run compiled Plans with Effect](TS-019-01-effect-compiled-plan-runner.md)
3. [TS-019-02 — Preserve cancellation and failure outcomes](TS-019-02-effect-cancellation-and-failures.md)
4. [TS-019-03 — Complete runtime boundaries and documentation](TS-019-03-effect-boundaries-and-documentation.md)

## Delivery order

TS-019-00 adds and proves the private Effect surface. TS-019-01 moves Plan
execution to that surface. TS-019-02 proves cancellation and failure parity.
TS-019-03 removes Mastra and closes the documentation and boundary work.

## Deferred

Parallel scheduling, retries, durable runs, persistence, resume, and human
interaction are outside this TS.
