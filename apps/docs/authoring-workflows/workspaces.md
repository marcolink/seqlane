# Workspaces

Workspace policy controls how workflow tasks overlap in one workspace. Declare
the policy on a task or child workflow invocation.

Seqlane starts each ready task when its dependencies and execution policies
permit it. It does not serialize tasks by declaration order.

`workspace: "exclusive"` is the default. An exclusive task waits for other
workspace work to finish. Then it runs alone.

`workspace: "shared"` permits concurrent workspace work. Use it for tasks that
can overlap safely.

## Choose a policy

Use `exclusive` as soon as a task can write to the workspace. This includes
agents that can edit files and shell tasks that can change repository state.

Use `shared` only for read-only work that can overlap safely, such as analysis,
search, or tests that do not write to the workspace. If you are not certain,
use `exclusive`.

```ts
.task("inspect", inspect, ({ input }) => input, {
  workspace: "shared",
})
.task("apply", apply, ({ input }) => input, {
  workspace: "exclusive",
})
```

## Example: workflow and execution order

### Workflow

This minimal workflow produces the execution order shown below. Task
definitions and schemas are omitted.

```ts
const workflow = createFlow({ id: "workspace-order", input, output })
  .task("api", reviewApi, ({ input }) => input, { workspace: "shared" })
  .task("ui", reviewUi, ({ input }) => input, { workspace: "shared" })
  .task("docs", scanDocs, ({ input }) => input, { workspace: "shared" })
  .task(
    "plan",
    plan,
    ({ tasks }) => ({ api: tasks.api.output, ui: tasks.ui.output }),
    { workspace: "shared" },
  )
  .task("apply", apply, ({ tasks }) => tasks.plan.output, {
    workspace: "exclusive",
  })
  .task("verify", verify, ({ tasks }) => tasks.apply.output, {
    workspace: "shared",
  })
  .output(({ tasks }) => tasks.verify.output)
  .define();
```

`Apply` has no data dependency on `docs`. It still waits for `Scan docs`
because it needs exclusive workspace access.

### Execution order

The example shows three shared tasks that start together. `Plan` waits only for
its data dependencies. `Apply` waits for `Plan` and for active shared workspace
work to finish.

<svg viewBox="0 0 760 420" width="100%" role="img" aria-labelledby="workspace-diagram-title workspace-diagram-description">
  <title id="workspace-diagram-title">Workspace policy and execution order</title>
  <desc id="workspace-diagram-description">Three shared tasks start in parallel. Plan waits for API and UI review. Apply waits for Plan and Docs scan because it needs exclusive workspace access. Verify starts after Apply.</desc>
  <defs>
    <marker id="workspace-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--vp-c-text-2)" />
    </marker>
  </defs>
  <g font-family="var(--vp-font-family-base)" fill="var(--vp-c-text-1)">
    <text x="20" y="30" font-size="16" font-weight="600">Ready shared tasks run in parallel</text>
    <text x="20" y="55" font-size="13" fill="var(--vp-c-text-2)">Solid arrows are data dependencies. The dashed line is workspace admission.</text>
    <line x1="45" y1="120" x2="45" y2="365" stroke="var(--vp-c-divider)" />
    <text x="18" y="105" font-size="13" fill="var(--vp-c-text-2)">start</text>
    <text x="18" y="390" font-size="13" fill="var(--vp-c-text-2)">later</text>
    <rect x="95" y="92" width="155" height="48" rx="6" fill="var(--vp-c-brand-soft)" stroke="var(--vp-c-brand-1)" />
    <text x="172" y="113" text-anchor="middle" font-size="14">Review API</text>
    <text x="172" y="130" text-anchor="middle" font-size="12" fill="var(--vp-c-text-2)">shared</text>
    <rect x="95" y="172" width="155" height="48" rx="6" fill="var(--vp-c-brand-soft)" stroke="var(--vp-c-brand-1)" />
    <text x="172" y="193" text-anchor="middle" font-size="14">Review UI</text>
    <text x="172" y="210" text-anchor="middle" font-size="12" fill="var(--vp-c-text-2)">shared</text>
    <rect x="95" y="252" width="155" height="48" rx="6" fill="var(--vp-c-brand-soft)" stroke="var(--vp-c-brand-1)" />
    <text x="172" y="273" text-anchor="middle" font-size="14">Scan docs</text>
    <text x="172" y="290" text-anchor="middle" font-size="12" fill="var(--vp-c-text-2)">shared</text>
    <rect x="360" y="132" width="155" height="48" rx="6" fill="var(--vp-c-bg-soft)" stroke="var(--vp-c-divider)" />
    <text x="437" y="153" text-anchor="middle" font-size="14">Plan</text>
    <text x="437" y="170" text-anchor="middle" font-size="12" fill="var(--vp-c-text-2)">shared</text>
    <rect x="570" y="212" width="155" height="48" rx="6" fill="var(--vp-c-warning-soft, var(--vp-c-bg-soft))" stroke="var(--vp-c-warning-1, var(--vp-c-brand-1))" />
    <text x="647" y="233" text-anchor="middle" font-size="14">Apply</text>
    <text x="647" y="250" text-anchor="middle" font-size="12" fill="var(--vp-c-text-2)">exclusive</text>
    <rect x="570" y="332" width="155" height="48" rx="6" fill="var(--vp-c-brand-soft)" stroke="var(--vp-c-brand-1)" />
    <text x="647" y="353" text-anchor="middle" font-size="14">Verify</text>
    <text x="647" y="370" text-anchor="middle" font-size="12" fill="var(--vp-c-text-2)">shared</text>
    <path d="M 250 116 H 310 V 150 H 360" fill="none" stroke="var(--vp-c-text-2)" stroke-width="1.5" marker-end="url(#workspace-arrow)" />
    <path d="M 250 196 H 310 V 162 H 360" fill="none" stroke="var(--vp-c-text-2)" stroke-width="1.5" marker-end="url(#workspace-arrow)" />
    <path d="M 515 156 H 540 V 236 H 570" fill="none" stroke="var(--vp-c-text-2)" stroke-width="1.5" marker-end="url(#workspace-arrow)" />
    <path d="M 250 276 H 540 V 252 H 570" fill="none" stroke="var(--vp-c-text-2)" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#workspace-arrow)" />
    <text x="325" y="270" font-size="12" fill="var(--vp-c-text-2)">wait for shared work</text>
    <path d="M 647 260 V 332" fill="none" stroke="var(--vp-c-text-2)" stroke-width="1.5" marker-end="url(#workspace-arrow)" />
  </g>
</svg>

When `Apply` releases the workspace, `Verify` can start. Other ready shared
tasks can also start at that point.

Workspace policy is scheduling policy. It does not grant tool permissions,
restrict file access, or make a task read-only. The selected runtime remains
responsible for permissions.
