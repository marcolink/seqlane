# Architecture decision records

| Key | Title | Status | Created | Owners |
| --- | --- | --- | --- | --- |
| [adr.semantic-validation-gates](./2026-09-02-semantic-validation-gates.md) | Add Semantic Validation Gates to Seqlane | accepted | 2026-09-02 | core |
| [adr.invocation-admission-and-workspace-coordination](./2026-09-02-invocation-admission-and-workspace-coordination.md) | Coordinate Invocation Admission Through DAGs, Sessions, and Workspaces | accepted | 2026-09-02 | core |
| [adr.decouple-executor-workspace-location](./2026-09-02-decouple-executor-workspace-location.md) | Decouple Executor Workspace Location from Seqlane Execution Location | accepted | 2026-09-02 | core |
| [adr.consumer-agnostic-seqlane-execution-events](./2026-09-02-consumer-agnostic-seqlane-execution-events.md) | Define Consumer-Agnostic Seqlane Execution Events | superseded | 2026-09-02 | core |
| [adr.work-run-invocation-identity-model](./2026-09-02-work-run-invocation-identity-model.md) | Distinguish Work, Run, and Invocation Identity | accepted | 2026-09-02 | core |
| [adr.dedicated-runner-process](./2026-09-02-dedicated-runner-process.md) | Execute Each Seqlane Run in a Dedicated Node Process | superseded | 2026-09-02 | core |
| [adr.opencode-executor-integration](./2026-09-02-opencode-executor-integration.md) | Integrate OpenCode Through a Seqlane-Owned Executor Boundary | accepted | 2026-09-02 | core |
| [adr.dedicated-seqlane-output-package](./2026-09-02-dedicated-seqlane-output-package.md) | Isolate Seqlane Execution Output in a Dedicated Package | superseded | 2026-09-02 | core |
| [adr.executor-neutral-workflow-authoring](./2026-09-02-executor-neutral-workflow-authoring.md) | Keep Workflow Authoring and Plans Executor-Neutral | superseded | 2026-09-02 | core |
| [adr.studio-vite-development-and-isolated-replay](./2026-09-02-studio-vite-development-and-isolated-replay.md) | Make Studio a Vite React App with Isolated Replay | superseded | 2026-09-02 | core |
| [adr.autonomous-non-interactive-execution](./2026-09-02-autonomous-non-interactive-execution.md) | Make V1 Workflow Execution Autonomous and Non-Interactive | accepted | 2026-09-02 | core |
| [adr.fluent-seqlane-flow-dsl](./2026-09-02-fluent-seqlane-flow-dsl.md) | Provide a Fluent Seqlane Flow DSL | superseded | 2026-09-02 | core |
| [adr.local-read-only-execution-studio](./2026-09-02-local-read-only-execution-studio.md) | Provide a Local Read-Only Execution Studio | superseded | 2026-09-02 | core |
| [adr.runtime-resolved-execution-profiles](./2026-09-02-runtime-resolved-execution-profiles.md) | Resolve Workflow Agent Profiles at Runtime | proposed | 2026-09-02 | core |
| [adr.session-checkpoint-reuse-and-branching](./2026-09-02-session-checkpoint-reuse-and-branching.md) | Reuse and Branch Run-Local Agent Sessions | accepted | 2026-09-02 | core |
| [adr.local-development-studio-trust-and-lifecycle](./2026-09-02-local-development-studio-trust-and-lifecycle.md) | Simplify the Local Development Studio Trust and Lifecycle | superseded | 2026-09-02 | core |
| [adr.builtin-workflow-distribution](./2026-09-02-builtin-workflow-distribution.md) | Store and Ship Built-in Workflows as a Dedicated Package | superseded | 2026-09-02 | core |
| [adr.repository-user-workflow-discovery-and-composition](./2026-09-02-repository-user-workflow-discovery-and-composition.md) | Support Repository and User Scoped Composition Using Ordinary TypeScript | proposed | 2026-09-02 | core |
| [adr.seqlane-plan-ir-and-typed-dataflow](./2026-09-02-seqlane-plan-ir-and-typed-dataflow.md) | Use a Seqlane-Owned Plan IR with Typed Dataflow | superseded | 2026-09-02 | core |
| [adr.effect-private-runtime-engine](./2026-09-02-effect-private-runtime-engine.md) | Use Effect as Seqlane's Private Runtime Engine | superseded | 2026-09-02 | core |
| [adr.mastra-internal-workflow-engine](./2026-09-02-mastra-internal-workflow-engine.md) | Use Mastra as Seqlane’s Internal Workflow Engine | superseded | 2026-09-02 | core |
| [adr.model-selection-and-session-model-semantics](./2026-09-03-model-selection-and-session-model-semantics.md) | Model Selection and Session Model Semantics | accepted | 2026-09-03 | core |
| [adr.local-mechanical-tasks](./2026-09-03-local-mechanical-tasks.md) | Run Local Mechanical Tasks Without an Agent | superseded | 2026-09-03 | core |
| [adr.mastra-local-mechanical-tasks](./2026-09-04-mastra-local-mechanical-tasks.md) | Run Local Mechanical Tasks Through Mastra LocalSandbox | accepted | 2026-09-04 | core |
| [adr.local-mastra-operational-host](./2026-09-05-local-mastra-operational-host.md) | Run Seqlane Through a Local Mastra Operational Host | accepted | 2026-09-05 | core |
| [adr.seqlane-action-library-boundary](./2026-09-06-seqlane-action-library-boundary.md) | Use an Action-Specific Library for Merge-Conflict Resolution | accepted | 2026-09-06 | core |
| [adr.mastra-native-agent-observability](./2026-09-07-mastra-native-agent-observability.md) | Project Executor Observations into Native Mastra Agent Observability | accepted | 2026-09-07 | core |
| [adr.mastra-backed-seqlane-workflows](./2026-09-08-mastra-backed-seqlane-workflows.md) | Center Seqlane Workflows on a Mastra-Backed Executable DSL | accepted | 2026-09-08 | core |
| [adr.direct-runtime-code-review-action](./2026-09-08-direct-runtime-code-review-action.md) | Run Trusted Code-Review Actions Through a Direct Runtime Service | accepted | 2026-09-08 | core |
| [adr.runner-built-action-bundles](./2026-09-11-runner-built-action-bundles.md) | Build Repository-Local GitHub Actions on the Runner | accepted | 2026-09-11 | core |
| [adr.use-runner-local-nx-cache](./2026-09-11-use-runner-local-nx-cache.md) | Use Runner-Local Nx Cache | accepted | 2026-09-11 | core |
| [adr.separate-seqlane-protocol-package](./2026-09-13-separate-seqlane-protocol-package.md) | Separate Seqlane Protocol Contracts from Core Authoring | accepted | 2026-09-13 | core |
| [adr.github-native-review-publication-state](./2026-09-14-github-native-review-publication-state.md) | Keep Review Publication State in a Comment and Evidence in Artifacts | accepted | 2026-09-14 | core |
| [adr.run-terminal-presentation-boundary](./2026-09-15-run-terminal-presentation-boundary.md) | Separate Run Terminal Presentation from Machine Results | accepted | 2026-09-15 | core |
