# TS-023 Implementation Stories

1. [TS-023-00 — Prove the Effect v3 subprocess contract](TS-023-00-effect-v3-subprocess-gate.md)
2. [TS-023-01 — Define local task contracts](TS-023-01-local-task-contracts.md)
3. [TS-023-02 — Serialize and validate local task nodes](TS-023-02-local-task-plan-validation.md)
4. [TS-023-03 — Run local tasks through Effect](TS-023-03-effect-local-task-execution.md)
5. [TS-023-04 — Complete lifecycle integration and documentation](TS-023-04-integration-documentation.md)

## Delivery order

Start with the Effect v3 gate. Stop this work if the gate fails. Then define
contracts, serialize and validate nodes, add runtime execution, and finish with
integration coverage and documentation. Each story is scoped to one independently
verifiable commit.
