# TS-021 Implementation Stories

1. [TS-021-00 — Define session checkpoint authoring and Plan contracts](TS-021-00-session-contracts.md)
2. [TS-021-01 — Validate combined checkpoint dependency graphs](TS-021-01-session-plan-validation.md)
3. [TS-021-02 — Resolve and publish Run-local session checkpoints](TS-021-02-runtime-checkpoint-lifecycle.md)
4. [TS-021-03 — Admit session and workspace resources atomically](TS-021-03-atomic-session-workspace-admission.md)
5. [TS-021-04 — Fork native OpenCode checkpoint sessions and document use](TS-021-04-opencode-fork-and-documentation.md)

## Delivery order

Contracts first, then graph validation, checkpoint lifecycle, admission, and
the OpenCode adapter/documentation. Every story is independently verified and
committed before the next starts.
