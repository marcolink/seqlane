# TS-022 Implementation Stories

1. [TS-022-00 — Define model refs, reasoning, and catalog helpers](TS-022-00-model-contracts.md)
2. [TS-022-01 — Carry session model selection through Plan contracts](TS-022-01-plan-model-selection.md)
3. [TS-022-02 — Validate model inheritance and session conflicts](TS-022-02-session-model-validation.md)
4. [TS-022-03 — Add executor model capabilities and runtime preflight](TS-022-03-model-preflight.md)
5. [TS-022-04 — Pin effective selections across runtime sessions](TS-022-04-session-model-pinning.md)
6. [TS-022-05 — Initialize OpenCode fork models before prompting](TS-022-05-opencode-model-forks.md)
7. [TS-022-06 — Record effective model selections in observability](TS-022-06-model-observability.md)
8. [TS-022-07 — Complete integration compatibility coverage and documentation](TS-022-07-integration-and-documentation.md)

## Delivery order

Start with the public contract, then serialize and validate selections, add
runtime capabilities and session pinning, integrate OpenCode fork setup, and
finish with observability and compatibility coverage. Each story is scoped to
one independently verifiable commit.
