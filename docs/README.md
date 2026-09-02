# Seqlane Architecture Artifacts

This directory contains the current canonical Seqlane design artifacts from the design discussion.

## Document Hierarchy

1. **BRD.md** — business need and desired outcomes.
2. **PRD.md** — product behavior and requirements.
3. **RFC-001-seqlane-technical-architecture.md** — technical architecture.
4. **RFC-002-execution-observability-and-debugging.md** — observability and debugging model.
5. **MVP.md** — minimum implementation profile and acceptance criteria.
6. **ADR-001-mastra-internal-workflow-engine.md** — historical private-engine decision, superseded by ADR-019.
7. **TS-001-mastra-runtime-integration.md** — historical implementation specification for ADR-001.
8. **stories/TS-001/** — implementation-ready stories derived from TS-001.
9. **ADR-002-dedicated-runner-process.md** — decision to execute each run in a fresh dedicated Node process.
10. **TS-002-dedicated-runner-process.md** — implementation specification for ADR-002.
11. **stories/TS-002/** — implementation-ready stories derived from TS-002.
12. **ADR-003-seqlane-plan-ir-and-typed-dataflow.md** — decision for the Seqlane Plan IR and typed dataflow.
13. **TS-003-seqlane-plan-ir-typed-dataflow.md** — implementation specification for ADR-003.
14. **stories/TS-003/** — implementation-ready stories derived from TS-003.
15. **ADR-004-opencode-executor-integration.md** — decision for the OpenCode executor integration.
16. **TS-004-opencode-executor-integration.md** — implementation specification for ADR-004.
17. **stories/TS-004/** — implementation-ready stories derived from TS-004.
18. **ADR-005-autonomous-non-interactive-execution.md** — decision for autonomous non-interactive execution.
19. **TS-005-autonomous-non-interactive-execution.md** — implementation specification for ADR-005.
20. **stories/TS-005/** — implementation-ready stories derived from TS-005.
21. **ADR-006-repository-user-workflow-discovery-and-composition.md** — decision for workflow discovery and composition.
22. **ADR-007-work-run-invocation-identity-model.md** — decision for Work, Run, and Invocation identities.
23. **TS-007-work-run-invocation-identity-model.md** — implementation specification for ADR-007.
24. **stories/TS-007/** — implementation-ready stories derived from TS-007.
25. **ADR-008-executor-neutral-workflow-authoring.md** — decision to keep workflow authoring and Plans independent of executor implementations.
26. **TS-008-executor-neutral-workflow-authoring.md** — implementation specification for ADR-008.
27. **stories/TS-008/** — implementation-ready stories derived from TS-008.
28. **ADR-009-builtin-workflow-distribution.md** — decision for storing and shipping built-in workflows.
29. **TS-009-builtin-workflow-distribution.md** — implementation specification for ADR-009.
30. **stories/TS-009/** — implementation-ready stories derived from TS-009.
31. **ADR-010-decouple-executor-workspace-location.md** — decision to decouple executor workspace location from Seqlane execution location.
32. **ADR-011-dedicated-seqlane-output-package.md** — decision to isolate execution output and renderer projections in a dedicated private package.
33. **TS-011-seqlane-execution-output-package.md** — implementation specification for ADR-011.
34. **stories/TS-011/** — implementation-ready stories derived from TS-011.
35. **ADR-012-fluent-seqlane-flow-dsl.md** — decision to provide a fluent, Seqlane-owned Flow DSL.
36. **TS-012-fluent-seqlane-flow-dsl.md** — implementation specification for ADR-012.
37. **stories/TS-012/** — implementation-ready stories derived from TS-012.
38. **ADR-013-local-read-only-execution-studio.md** — decision for a local, read-only browser view of concurrent Seqlane runs.
39. **TS-013-local-read-only-execution-studio.md** — implementation specification for the local execution Studio.
40. **stories/TS-013/** — implementation-ready stories derived from TS-013.
41. **ADR-014-local-development-studio-trust-and-lifecycle.md** — decision to simplify local Studio access, discovery, and shutdown.
42. **TS-014-local-development-studio-trust-and-lifecycle.md** — implementation specification for simplified local Studio access and lifecycle.
43. **stories/TS-014/** — implementation-ready stories derived from TS-014.
44. **ADR-015-semantic-validation-gates.md** — decision to add semantic validation gates.
45. **TS-015-semantic-validation-gates.md** — implementation specification for ADR-015.
46. **stories/TS-015/** — implementation-ready stories derived from TS-015.
47. **ADR-016-consumer-agnostic-seqlane-execution-events.md** — decision for a
    canonical execution-event contract and independent consumers.
48. **TS-016-consumer-agnostic-seqlane-execution-events.md** — implementation
    specification for ADR-016.
49. **stories/TS-016/** — implementation-ready stories derived from TS-016.
50. **ADR-017-studio-vite-development-and-isolated-replay.md** — proposed
    decision for Studio HMR, bundling, and browser-local replay.
51. **TS-017-studio-vite-development-and-isolated-replay.md** — proposed
    implementation specification for ADR-017.
52. **stories/TS-017/** — proposed implementation stories derived from TS-017.
53. **ADR-018-runtime-resolved-execution-profiles.md** — proposed decision for
    runtime-owned agent profiles, adapter configuration, and agent
    transition handling.
54. **TS-018-runtime-resolved-execution-profiles.md** — proposed
    implementation specification for runtime-resolved agent profiles.
55. **stories/TS-018/** — proposed implementation stories derived from TS-018.
56. **ADR-019-effect-private-runtime-engine.md** — implemented decision to use Effect as the private runtime engine.
57. **TS-019-effect-runtime-integration.md** — implemented specification for ADR-019.
58. **stories/TS-019/** — completed implementation stories derived from TS-019.
59. **ADR-020-invocation-admission-and-workspace-coordination.md** — proposed
    decision for DAG, session, and workspace admission.
60. **ADR-020-invocation-admission-audit.md** — rule-by-rule baseline audit
    for ADR-020.
61. **ADR-021-session-checkpoint-reuse-and-branching.md** — decision for
    Run-local agent-session checkpoints, reuse, and native branching.
62. **TS-021-session-checkpoint-reuse-and-branching.md** — implementation
    specification for ADR-021.
63. **stories/TS-021/** — implementation stories derived from TS-021.
64. **ADR-022-model-selection-and-session-model-semantics.md** — decision for
    executor-neutral model selection and session model pinning.
65. **TS-022-model-selection-and-session-model-semantics.md** — implementation
    specification for ADR-022.
66. **stories/TS-022/** — implementation stories derived from TS-022.

Current status:

- Implemented: ADR/TS 001–005, 007–009, and 011–014; TS-015.
- Accepted: ADR-015.
- Proposed: ADR-006 and ADR-010; no TS-006 or TS-010 exists yet.
- Accepted: ADR-016 and TS-016; TS-016 stories are ready for implementation.
- Proposed: ADR-017 and TS-017; TS-017 stories are ready for review.
- Proposed: ADR-018 and TS-018; TS-018 stories are ready for review.
- Implemented: ADR-019 and TS-019. ADR-019 supersedes ADR-001.
- Proposed: ADR-020. Its rule-by-rule baseline audit is complete.
- Accepted: ADR-021 and TS-021; TS-021 stories are ready for implementation.
- Accepted: ADR-022. TS-022 is ready for implementation; TS-022-00 through
  TS-022-02 are completed, and the remaining stories are planned.
