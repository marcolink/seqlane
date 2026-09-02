# TS-018 Implementation Stories

1. [TS-018-00 — Add executor-neutral agent keys](TS-018-00-execution-key-contracts.md)
2. [TS-018-01 — Add runtime agent profiles and configuration](TS-018-01-runtime-execution-profiles.md)
3. [TS-018-02 — Add agent preflight and aggregate validation](TS-018-02-execution-preflight.md)
4. [TS-018-03 — Resolve OpenCode profiles and guard session transitions](TS-018-03-opencode-profile-transitions.md)
5. [TS-018-04 — Emit and consume agent warnings](TS-018-04-execution-warning-events.md)
6. [TS-018-05 — Complete compatibility, security, and boundary coverage](TS-018-05-compatibility-and-boundaries.md)

## Delivery order

TS-018-00 defines the public agent-key contract. TS-018-01 adds the private
configuration and registry. TS-018-02 validates all references before session
creation. TS-018-03 connects profiles to OpenCode and rejects unsafe
transitions. TS-018-04 adds the canonical warning event and consumers.
TS-018-05 closes compatibility, security, and boundary gaps.

## Deferred

Direct model references, profile overlays, multiple sessions, explicit session
boundaries, context handoff, dynamic profile selection, and executor-neutral
capability requirements remain outside TS-018.
