# Plan

Seqlane turns a workflow DSL definition into a Plan before it starts work. The
Plan is the serializable execution graph for that run.

Seqlane uses the Plan to validate dependencies, sessions, workspaces,
repetition, and the final output binding before execution. Task inputs and
outputs validate at each task boundary. The runtime uses the validated Plan to
schedule work.

## Show a Plan

Use `--dry` with `seqlane run` to print the calculated Plan without executing
workflow tasks.

```sh
seqlane run ./workflow.ts --input '{}' --dry
```

## Execute a Plan

The runtime validates workflow and task inputs and outputs at their boundaries.
It starts each ready task when its data, session, explicit dependency,
workspace, and runtime-capacity rules permit it.

Seqlane maximizes safe parallelism. Independent tasks can run in parallel.
Tasks that reuse one session do not run at the same time. An exclusive workspace
task does not overlap other workspace work.

Read [Sessions](/authoring-workflows/sessions),
[Workspaces](/authoring-workflows/workspaces), and
[Model selection](/authoring-workflows/models) for the exact rules.

## From DSL to Plan

This workflow has two tasks. `summarize` reads the output of `inspect`.

```ts
const workflow = createFlow({ id: "review", input, output })
  .task("inspect", inspect, ({ input }) => ({ repository: input.repository }))
  .task("summarize", summarize, ({ tasks }) => ({
    findings: tasks.inspect.output.findings,
  }))
  .output(({ tasks }) => tasks.summarize.output)
  .define();
```

Its Plan has two task nodes. The second node refers to the first node output,
so it depends on the first node.

```json
{
  "workflow": { "id": "review" },
  "nodes": [
    {
      "type": "task",
      "taskId": "inspect",
      "nodeId": "inspect:1",
      "workspace": "exclusive",
      "input": {
        "repository": {
          "type": "ref",
          "nodeId": "__seqlane_input",
          "path": ["repository"]
        }
      },
      "dependsOn": []
    },
    {
      "type": "task",
      "taskId": "summarize",
      "nodeId": "summarize:1",
      "workspace": "exclusive",
      "input": {
        "findings": {
          "type": "ref",
          "nodeId": "inspect:1",
          "path": ["output", "findings"]
        }
      },
      "dependsOn": ["inspect:1"]
    }
  ],
  "output": {
    "type": "ref",
    "nodeId": "summarize:1",
    "path": ["output"]
  }
}
```

The Plan stores task-output links as references, not copied values. A reference
to a prior task output creates the dependency that controls execution order.

## What a node records

A Plan node records the task or child workflow, its input binding, dependencies,
and workspace policy. Agent task nodes can also record session policy and model
selection. Repeat and validation nodes record their own execution rules.

Read [Dependencies](/authoring-workflows/dependencies) for binding references
and [Workflow composition](/authoring-workflows/workflow-composition) for child
workflow nodes.
