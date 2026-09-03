import { describe, expect, it } from "vitest";
import {
  definePlan,
  defineTask,
  defineWorkflow,
  createFlow,
  createValueRef,
  createWorkflowInputRef,
  buildPlan,
  buildWorkflow,
  type TaskDefinition,
  type SeqlaneSchema,
  type InputBinding,
  type SessionCheckpointRef,
  type ValueRef,
  type ValidationResult,
  type WorkflowDefinition,
  InteractionRequiredError,
  isolated,
  reuse,
} from "./index.js";

const schema = <T>(): SeqlaneSchema<T> => ({
  parse(value: unknown): T {
    return value as T;
  },
});

describe("seqlane core", () => {
  it("defines an agent task without a work discriminator", () => {
    const task = defineTask({
      id: "agent-task",
      workspace: "shared",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly answer: string }>(),
      goal: ({ request }) => `Answer ${request}`,
      instructions: ["Return a concise answer."],
      references: ["README.md"],
    });

    expect(task.goal({ request: "question" })).toBe("Answer question");
    expect(task.instructions).toEqual(["Return a concise answer."]);
    expect(task.references).toEqual(["README.md"]);
  });

  it("defines local tasks with an output-only Flow handle", () => {
    const local = defineTask({
      id: "local-status",
      input: schema<{ readonly repository: string }>(),
      output: schema<{ readonly clean: boolean }>(),
      execute: async (_input, { exec }) => {
        const result = await exec({ command: "git", args: ["status"] });
        return { clean: result.exitCode === 0 };
      },
    });
    const agent = defineTask({
      id: "agent-report",
      input: schema<{ readonly clean: boolean }>(),
      output: schema<{ readonly report: string }>(),
      goal: ({ clean }) => (clean ? "Report clean" : "Report changes"),
    });

    const flow = createFlow({
      id: "local-handle-contract",
      input: schema<{ readonly repository: string }>(),
      output: schema<{ readonly report: string }>(),
    })
      .task("status", local, ({ input }) => ({ repository: input.repository }))
      .task("report", agent, ({ tasks }) => ({
        clean: tasks.status.output.clean,
      }))
      .output(({ tasks }) => {
        const checkpoint: SessionCheckpointRef = tasks.report.session;
        expect(checkpoint).toBeDefined();
        // @ts-expect-error Local task handles do not expose session checkpoints.
        reuse(tasks.status.session);
        return tasks.report.output;
      });

    const workflow = flow.define();
    const built = buildWorkflow(workflow);

    expect(workflow.id).toBe("local-handle-contract");
    expect(built.taskDefinitions.get(local.id)).toBe(local);
  });

  it("rejects local task session options statically", () => {
    const local = defineTask({
      id: "local-session-options",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      execute: async () => ({}),
    });
    const flow = createFlow({
      id: "local-session-options-flow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
    });

    // @ts-expect-error Local task invocation options do not support sessions.
    flow.task("local", local, () => ({}), { session: isolated() });

    defineWorkflow({
      id: "local-session-options-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      build: ({ input, run }) => {
        // @ts-expect-error Local task invocation options do not support sessions.
        return run(local, { input, session: isolated() }).output;
      },
    });
  });

  it("rejects mixed and missing task behavior at type and runtime boundaries", () => {
    expect(() => {
      // @ts-expect-error A task cannot define both agent and local behavior.
      defineTask({
        id: "mixed-task",
        input: schema<Record<never, never>>(),
        output: schema<Record<never, never>>(),
        goal: () => "work",
        execute: async () => ({}),
      });
    }).toThrow();
    expect(() => {
      // @ts-expect-error A task must define agent or local behavior.
      defineTask({
        id: "missing-task-behavior",
        input: schema<Record<never, never>>(),
        output: schema<Record<never, never>>(),
      });
    }).toThrow();
  });

  it("permits omitted workspace policy", () => {
    const missingWorkspace = {
      id: "missing-workspace",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly answer: string }>(),
      goal: ({ request }: { readonly request: string }) => request,
    };

    const task: TaskDefinition<
      { readonly request: string },
      { readonly answer: string }
    > = missingWorkspace;

    expect(task.id).toBe("missing-workspace");
  });

  it("rejects removed permission and workspace capability fields statically", () => {
    defineTask({
      id: "old-workspace-value",
      // @ts-expect-error Old workspace capabilities are not valid policies
      workspace: "read",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "work",
    });
    // @ts-expect-error Seqlane no longer exposes per-task permissions
    defineTask({
      id: "old-permission-field",
      workspace: "shared",
      permissions: { workspace: "read" },
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "work",
    });
  });

  it("creates typed Flow handles without exposing results", () => {
    const inspect = defineTask({
      id: "inspect",
      workspace: "shared",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly summary: string }>(),
      goal: ({ request }) => request,
    });
    const summarize = defineTask({
      id: "summarize",
      workspace: "shared",
      input: schema<{ readonly summary: string }>(),
      output: schema<{ readonly result: string }>(),
      goal: ({ summary }) => summary,
    });

    const flow = createFlow({
      id: "flow-contract",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly result: string }>(),
    })
      .task("inspect", inspect, ({ input }) => ({ request: input.request }))
      .task("summarize", summarize, ({ tasks }) => ({
        summary: tasks.inspect.output.summary,
      }))
      .output(({ tasks }) => tasks.summarize.output);

    const workflow: WorkflowDefinition<
      { readonly request: string },
      { readonly result: string }
    > = flow.define();
    expect(workflow.id).toBe("flow-contract");
  });

  it("exposes immutable session checkpoints only on agent task handles", () => {
    const task = defineTask({
      id: "session-source",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly value: string }>(),
      goal: () => "work",
    });
    const workflow = defineWorkflow({
      id: "session-source-workflow",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly value: string }>(),
      build: ({ input, run, validate }) => {
        const source = run(task, { input });
        const checkpoint: SessionCheckpointRef = source.session;
        expect(checkpoint).toMatchObject({
          type: "session-checkpoint",
          nodeId: "session-source:1",
        });
        const validation = validate(
          {
            id: "mechanical-validation",
            input: schema<{ readonly value: string }>(),
            validate: () => ({ success: true }),
          },
          { input: source.output },
        );
        // @ts-expect-error Mechanical validation handles do not produce sessions
        reuse(validation.session);
        return source.output;
      },
    });

    expect(buildWorkflow(workflow).plan.nodes).toHaveLength(3);
  });

  it("rejects widened, duplicate, and unknown Flow names statically", () => {
    const task = defineTask({
      id: "flow-task",
      workspace: "shared",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly value: string }>(),
      goal: ({ value }) => value,
    });
    const name = (): string => "task";
    const builder = createFlow({
      id: "flow-types",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly value: string }>(),
    }).task("task", task, ({ input }) => ({ value: input.value }));

    const widenedBuilder = createFlow({
      id: "widened-name",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly value: string }>(),
    });
    // @ts-expect-error Flow names must be string literals
    widenedBuilder.task(name(), task, ({ input }) => ({ value: input.value }));
    // @ts-expect-error Flow names must be unique
    builder.task("task", task, ({ input }) => ({ value: input.value }));
    builder.output(({ tasks }) => {
      // @ts-expect-error unknown handles are unavailable
      return tasks.unknown.output;
    });
  });

  it("requires literal unique names for validation handles", () => {
    const validator = {
      id: "flow-name-validator",
      input: schema<{ readonly value: string }>(),
      validate: (): ValidationResult => ({ success: true }),
    };
    const name = (): string => "checked";
    const builder = createFlow({
      id: "validation-name-types",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly value: string }>(),
    }).validate("checked", validator, ({ input }) => input);

    const widenedBuilder = createFlow({
      id: "widened-validation-name",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly value: string }>(),
    });
    // @ts-expect-error Flow names must be string literals
    widenedBuilder.validate(name(), validator, ({ input }) => input);
    // @ts-expect-error Flow names must be unique
    builder.validate("checked", validator, ({ input }) => input);
  });
  it.each(["user-input", "confirmation", "option-selection"] as const)(
    "defines a safe interaction failure for %s",
    (requirement) => {
      const error = new InteractionRequiredError(requirement);

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("InteractionRequiredError");
      expect(error.requirement).toBe(requirement);
      expect(error.message).toBe(
        "Seqlane execution requires human interaction",
      );
      expect(error.message).not.toContain(requirement);
    },
  );

  it("defines a Mastra-independent static plan", () => {
    const plan = definePlan({
      workflow: { id: "example" },
      nodes: [
        {
          type: "task",
          taskId: "investigate",
          nodeId: "investigate:1",
          workspace: "shared",
          execution: "agent",
          session: { type: "isolated" },
          dependsOn: [],
          input: { repository: "seqlane" },
        },
      ],
      output: { type: "ref", nodeId: "investigate:1", path: [] },
    });

    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0]?.type).toBe("task");
  });

  it("defines typed tasks and workflows with core-owned contracts", () => {
    interface Input {
      readonly request: string;
    }
    interface Output {
      readonly files: string[];
    }

    const task: TaskDefinition<Input, Output> = defineTask({
      id: "investigate",
      workspace: "shared",
      input: schema<Input>(),
      output: schema<Output>(),
      goal: ({ request }) => `Investigate ${request}`,
    });
    const workflow: WorkflowDefinition<Input, Output> = defineWorkflow({
      id: "example",
      input: schema<Input>(),
      output: schema<Output>(),
      build: ({ input }) => {
        expect(input.request).toBeDefined();
        return { files: [] };
      },
    });

    expect(task.id).toBe("investigate");
    expect(workflow.id).toBe("example");
    expect(workflow.input.parse({ request: "demo" })).toEqual({
      request: "demo",
    });
  });

  it("serializes nested references without proxy state", () => {
    const result = createValueRef<{
      readonly files: string[];
    }>("investigate:1");
    const files: ValueRef<string[]> = result.files;

    expect(files).toEqual({
      type: "ref",
      nodeId: "investigate:1",
      path: ["files"],
    });
    expect(JSON.parse(JSON.stringify(files))).toEqual({
      type: "ref",
      nodeId: "investigate:1",
      path: ["files"],
    });
  });

  it("creates a typed workflow-input reference", () => {
    const input = createWorkflowInputRef<{
      readonly request: string;
    }>();

    expect(input.request).toEqual({
      type: "ref",
      nodeId: "__seqlane_input",
      path: ["request"],
    });
  });

  it("accepts compatible literals and references only", () => {
    const files = createValueRef<string[]>("investigate:1", ["files"]);
    const valid: InputBinding<{ readonly files: string[] }> = {
      files,
    };

    expect(valid).toEqual({ files });

    const invalid: InputBinding<{ readonly files: string[] }> = {
      // @ts-expect-error number is not compatible with string
      files: [1, 2, 3],
    };
    expect(invalid).toBeDefined();
  });

  it("builds a deterministic Plan from inferred dataflow", () => {
    let executions = 0;
    const investigate = defineTask({
      id: "investigate",
      workspace: "shared",
      input: schema<{ request: string }>(),
      output: schema<{ files: string[] }>(),
      goal: ({ request }) => request,
    });
    const planTask = defineTask({
      id: "plan",
      workspace: "shared",
      input: schema<{ files: string[] }>(),
      output: schema<{ steps: string[] }>(),
      goal: (input) => `Create a plan for ${input.files.join(", ")}`,
    });
    const workflow = defineWorkflow({
      id: "dataflow",
      input: schema<{ request: string }>(),
      output: schema<{ steps: string[] }>(),
      build: ({ input, run }) => {
        const investigation = run(investigate, {
          input: { request: input.request },
        });
        const result = run(planTask, {
          input: { files: investigation.output.files },
        });
        return { steps: result.output.steps };
      },
    });

    const built = buildWorkflow(workflow);
    executions += built.plan.nodes.length;

    expect(built.plan).toEqual({
      workflow: { id: "dataflow" },
      nodes: [
        {
          type: "task",
          taskId: "investigate",
          nodeId: "investigate:1",
          workspace: "shared",
          execution: "agent",
          session: { type: "isolated" },
          input: {
            request: {
              type: "ref",
              nodeId: "__seqlane_input",
              path: ["request"],
            },
          },
          dependsOn: [],
        },
        {
          type: "task",
          taskId: "plan",
          nodeId: "plan:1",
          workspace: "shared",
          execution: "agent",
          session: { type: "isolated" },
          input: {
            files: {
              type: "ref",
              nodeId: "investigate:1",
              path: ["output", "files"],
            },
          },
          dependsOn: ["investigate:1"],
        },
      ],
      output: {
        steps: {
          type: "ref",
          nodeId: "plan:1",
          path: ["output", "steps"],
        },
      },
    });
    expect(built.taskDefinitions.get("investigate")).toBe(investigate);
    expect(executions).toBe(2);
  });

  it("lowers a Flow through the existing workflow Plan builder", () => {
    const first = defineTask({
      id: "first",
      workspace: "shared",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly value: string }>(),
      goal: ({ request }) => request,
    });
    const second = defineTask({
      id: "second",
      workspace: "shared",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly result: string }>(),
      goal: ({ value }) => value,
    });
    const flow = createFlow({
      id: "lowered-flow",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly result: string }>(),
    })
      .task("first", first, ({ input }) => ({ request: input.request }))
      .task("second", second, ({ tasks }) => ({
        value: tasks.first.output.value,
      }))
      .output(({ tasks }) => tasks.second.output);

    expect(buildWorkflow(flow.define()).plan).toEqual({
      workflow: { id: "lowered-flow" },
      nodes: [
        {
          type: "task",
          taskId: "first",
          nodeId: "first:1",
          workspace: "shared",
          execution: "agent",
          session: { type: "isolated" },
          input: {
            request: {
              type: "ref",
              nodeId: "__seqlane_input",
              path: ["request"],
            },
          },
          dependsOn: [],
        },
        {
          type: "task",
          taskId: "second",
          nodeId: "second:1",
          workspace: "shared",
          execution: "agent",
          session: { type: "isolated" },
          input: {
            value: {
              type: "ref",
              nodeId: "first:1",
              path: ["output", "value"],
            },
          },
          dependsOn: ["first:1"],
        },
      ],
      output: {
        type: "ref",
        nodeId: "second:1",
        path: ["output"],
      },
    });
  });

  it("retains all task-only Flow connection forms", () => {
    const repository = defineTask({
      id: "repository",
      workspace: "shared",
      input: schema<{ readonly repository: string }>(),
      output: schema<{ readonly baseBranch: string }>(),
      goal: ({ repository }) => repository,
    });
    const analysis = defineTask({
      id: "analysis",
      workspace: "shared",
      input: schema<{ readonly baseBranch: string }>(),
      output: schema<{ readonly analysis: string }>(),
      goal: ({ baseBranch }) => baseBranch,
    });
    const suite = defineTask({
      id: "suite",
      workspace: "shared",
      input: schema<{
        readonly repository: string;
        readonly baseBranch: string;
        readonly suite: string;
      }>(),
      output: schema<{ readonly passed: boolean }>(),
      goal: ({ suite: suiteName }) => suiteName,
    });
    const policy = defineTask({
      id: "policy",
      workspace: "shared",
      input: schema<{ readonly version: string }>(),
      output: schema<{ readonly policy: string }>(),
      goal: ({ version }) => version,
    });
    const report = defineTask({
      id: "report",
      workspace: "shared",
      input: schema<{
        readonly analysis: string;
        readonly unitPassed: boolean;
        readonly integrationPassed: boolean;
        readonly policy: string;
      }>(),
      output: schema<{ readonly complete: boolean }>(),
      goal: () => "report",
    });
    const plan = buildWorkflow(
      createFlow({
        id: "all-flow-connections",
        input: schema<{ readonly repository: string }>(),
        output: schema<{
          readonly baseBranch: string;
          readonly complete: boolean;
        }>(),
      })
        .task("sourceHandle", repository, ({ input }) => ({
          repository: input.repository,
        }))
        .task(
          "analysisHandle",
          analysis,
          ({ tasks }) => tasks.sourceHandle.output,
        )
        .task("unitHandle", suite, ({ input, tasks }) => ({
          repository: input.repository,
          baseBranch: tasks.sourceHandle.output.baseBranch,
          suite: "unit",
        }))
        .task("integrationHandle", suite, ({ input, tasks }) => ({
          repository: input.repository,
          baseBranch: tasks.sourceHandle.output.baseBranch,
          suite: "integration",
        }))
        .task("policyHandle", policy, () => ({ version: "v1" }))
        .task("reportHandle", report, ({ tasks }) => ({
          analysis: tasks.analysisHandle.output.analysis,
          unitPassed: tasks.unitHandle.output.passed,
          integrationPassed: tasks.integrationHandle.output.passed,
          policy: tasks.policyHandle.output.policy,
        }))
        .output(({ tasks }) => ({
          baseBranch: tasks.sourceHandle.output.baseBranch,
          complete: tasks.reportHandle.output.complete,
        }))
        .define(),
    ).plan;

    expect(
      plan.nodes.map(({ nodeId, dependsOn }) => ({ nodeId, dependsOn })),
    ).toEqual([
      { nodeId: "repository:1", dependsOn: [] },
      { nodeId: "analysis:1", dependsOn: ["repository:1"] },
      { nodeId: "suite:1", dependsOn: ["repository:1"] },
      { nodeId: "suite:2", dependsOn: ["repository:1"] },
      { nodeId: "policy:1", dependsOn: [] },
      {
        nodeId: "report:1",
        dependsOn: ["analysis:1", "suite:1", "suite:2", "policy:1"],
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain("sourceHandle");
    expect(JSON.stringify(plan)).not.toContain("integrationHandle");
  });

  it("builds a bounded Repeat Plan node with deterministic body addresses", () => {
    const repair = defineTask({
      id: "repair",
      workspace: "shared",
      input: schema<{ readonly passed: boolean }>(),
      output: schema<{ readonly passed: boolean }>(),
      goal: () => "repair",
    });
    const plan = buildWorkflow(
      createFlow({
        id: "repeat-flow",
        input: schema<{ readonly passed: boolean }>(),
        output: schema<{ readonly passed: boolean }>(),
      })
        .repeat("repairLoop", {
          initial: ({ input }) => input,
          body: ({ input, task }) => task(repair, { input }).output,
          until: ({ output }) => output.passed,
          maximumIterations: 3,
        })
        .output(({ tasks }) => tasks.repairLoop.output)
        .define(),
    ).plan;

    expect(plan.nodes).toMatchObject([
      {
        type: "repeat",
        nodeId: "repeat:1",
        maximumIterations: 3,
        body: {
          inputNodeId: "repeat:1:input",
          nodes: [{ nodeId: "repeat:1/repair:1" }],
          until: {
            type: "ref",
            nodeId: "repeat:1/repair:1",
            path: ["output", "passed"],
          },
        },
      },
    ]);
  });

  it("keeps independent and repeated invocations distinct", () => {
    const task = defineTask({
      id: "work",
      workspace: "shared",
      input: schema<{ value: string }>(),
      output: schema<{ value: string }>(),
      goal: ({ value }) => value,
    });
    const workflow = defineWorkflow({
      id: "independent",
      input: schema<{ value: string }>(),
      output: schema<{ values: string[] }>(),
      build: ({ run }) => {
        const first = run(task, { input: { value: "a" } });
        const second = run(task, { input: { value: "b" } });
        return { values: [first.output.value, second.output.value] };
      },
    });

    expect(buildPlan(workflow).nodes).toMatchObject([
      { nodeId: "work:1", dependsOn: [] },
      { nodeId: "work:2", dependsOn: [] },
    ]);
  });
});
