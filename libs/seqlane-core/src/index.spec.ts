import { describe, expect, it } from "vitest";
import {
  defineAgentTask,
  defineShellTask,
  defineTask,
  createFlow,
  createValueRef,
  createWorkflowInputRef,
  buildWorkflow,
  type TaskDefinition,
  type InputBinding,
  type SessionCheckpointRef,
  type ValueRef,
  type ValidationResult,
  type WorkflowDefinition,
  InteractionRequiredError,
  isolated,
  reuse,
} from "./index.js";
import { z } from "zod";

const schema = <T>() => z.custom<T>(() => true);

describe("seqlane core", () => {
  it("defines an agent task through the unified task contract", () => {
    const task = defineAgentTask({
      id: "agent-task",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly answer: string }>(),
      goal: ({ request }) => `Answer ${request}`,
      instructions: ["Return a concise answer."],
      references: ["README.md"],
    });

    expect(typeof task.execute).toBe("function");
  });

  it("defines tasks with the unified execution contract", () => {
    const local = defineTask({
      id: "local-status",
      input: schema<{ readonly repository: string }>(),
      output: schema<{ readonly clean: boolean }>(),
      execute: async ({ context }) => {
        const result = await context.exec({
          executable: "git",
          argv: ["status"],
        });
        return { clean: result.exitCode === 0 };
      },
    });
    const agent = defineAgentTask({
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
      .task(
        "report",
        agent,
        ({ tasks }) => ({ clean: tasks.status.output.clean }),
        {
          session: isolated(),
        },
      )
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

  it("rejects ignored output configuration for shell tasks", () => {
    expect(() => {
      defineShellTask({
        id: "shell-output",
        input: schema<Record<never, never>>(),
        output: schema<Record<never, never>>(),
        executable: "true",
        argv: () => [],
      } as never);
    }).toThrow("defineShellTask does not accept output");
  });

  it("rejects local task session options statically", () => {
    const local = defineTask({
      id: "local-session-options",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      execute: async () => ({}),
    });
    const workflow = createFlow({
      id: "local-session-options-flow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
    })
      .task("local", local, () => ({}), { session: isolated() })
      .output(({ tasks }) => tasks.local.output)
      .define();
    expect(() => buildWorkflow(workflow)).not.toThrow();
  });

  it("rejects mixed and missing task behavior at type and runtime boundaries", () => {
    expect(() => {
      defineAgentTask({
        id: "mixed-task",
        input: schema<Record<never, never>>(),
        output: schema<Record<never, never>>(),
        goal: () => "work",
        execute: async () => ({}),
      } as never);
    }).toThrow();
    expect(() => {
      // @ts-expect-error A task must define execute.
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
      execute: async () => ({ answer: "" }),
    };

    const task: TaskDefinition<
      { readonly request: string },
      { readonly answer: string }
    > = missingWorkspace;

    expect(task.id).toBe("missing-workspace");
  });

  it("creates typed Flow handles without exposing results", () => {
    const inspect = defineAgentTask({
      id: "inspect",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly summary: string }>(),
      goal: ({ request }) => request,
    });
    const summarize = defineAgentTask({
      id: "summarize",
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
    const task = defineAgentTask({
      id: "session-source",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly value: string }>(),
      goal: () => "work",
    });
    const workflow = createFlow({
      id: "session-source-workflow",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly value: string }>(),
    })
      .task("source", task, ({ input }) => input, { session: isolated() })
      .validate(
        "check",
        {
          id: "mechanical-validation",
          input: schema<{ readonly value: string }>(),
          validate: () => ({ success: true }),
        },
        ({ tasks }) => tasks.source.output,
      )
      .output(({ tasks }) => {
        const checkpoint: SessionCheckpointRef = tasks.source.session;
        expect(checkpoint).toMatchObject({
          type: "session-checkpoint",
          nodeId: "session-source:1",
        });
        // @ts-expect-error Mechanical validation handles do not produce sessions
        reuse(tasks.check.session);
        return tasks.source.output;
      })
      .define();

    expect(buildWorkflow(workflow).plan.nodes).toHaveLength(3);
  });

  it("rejects widened, duplicate, and unknown Flow names statically", () => {
    const task = defineAgentTask({
      id: "flow-task",
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

  it("defines typed tasks and workflows with core-owned contracts", () => {
    interface Input {
      readonly request: string;
    }
    interface Output {
      readonly files: string[];
    }

    const task: TaskDefinition<Input, Output> = defineAgentTask({
      id: "investigate",
      input: schema<Input>(),
      output: schema<Output>(),
      goal: ({ request }) => `Investigate ${request}`,
    });
    const workflow: WorkflowDefinition<Input, Output> = createFlow({
      id: "example",
      input: schema<Input>(),
      output: schema<Output>(),
    })
      .task("investigate", task, ({ input }) => input)
      .output(({ tasks }) => tasks.investigate.output)
      .define();

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
    const investigate = defineAgentTask({
      id: "investigate",
      input: schema<{ request: string }>(),
      output: schema<{ files: string[] }>(),
      goal: ({ request }) => request,
    });
    const planTask = defineAgentTask({
      id: "plan",
      input: schema<{ files: string[] }>(),
      output: schema<{ steps: string[] }>(),
      goal: (input) => `Create a plan for ${input.files.join(", ")}`,
    });
    const workflow = createFlow({
      id: "dataflow",
      input: schema<{ request: string }>(),
      output: schema<{ steps: string[] }>(),
    })
      .task("investigate", investigate, ({ input }) => ({
        request: input.request,
      }))
      .task("plan", planTask, ({ tasks }) => ({
        files: tasks.investigate.output.files,
      }))
      .output(({ tasks }) => ({ steps: tasks.plan.output.steps }))
      .define();

    const built = buildWorkflow(workflow);
    executions += built.plan.nodes.length;

    expect(built.plan).toEqual({
      workflow: { id: "dataflow" },
      nodes: [
        {
          type: "task",
          taskId: "investigate",
          nodeId: "investigate:1",
          workspace: "exclusive",
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
          workspace: "exclusive",
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
    const first = defineAgentTask({
      id: "first",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly value: string }>(),
      goal: ({ request }) => request,
    });
    const second = defineAgentTask({
      id: "second",
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
          workspace: "exclusive",
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
          workspace: "exclusive",
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
    const repository = defineAgentTask({
      id: "repository",
      input: schema<{ readonly repository: string }>(),
      output: schema<{ readonly baseBranch: string }>(),
      goal: ({ repository }) => repository,
    });
    const analysis = defineAgentTask({
      id: "analysis",
      input: schema<{ readonly baseBranch: string }>(),
      output: schema<{ readonly analysis: string }>(),
      goal: ({ baseBranch }) => baseBranch,
    });
    const suite = defineAgentTask({
      id: "suite",
      input: schema<{
        readonly repository: string;
        readonly baseBranch: string;
        readonly suite: string;
      }>(),
      output: schema<{ readonly passed: boolean }>(),
      goal: ({ suite: suiteName }) => suiteName,
    });
    const policy = defineAgentTask({
      id: "policy",
      input: schema<{ readonly version: string }>(),
      output: schema<{ readonly policy: string }>(),
      goal: ({ version }) => version,
    });
    const report = defineAgentTask({
      id: "report",
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
    const repair = defineAgentTask({
      id: "repair",
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
    const task = defineAgentTask({
      id: "work",
      input: schema<{ value: string }>(),
      output: schema<{ value: string }>(),
      goal: ({ value }) => value,
    });
    const workflow = createFlow({
      id: "independent",
      input: schema<{ value: string }>(),
      output: schema<{ values: string[] }>(),
    })
      .task("first", task, () => ({ value: "a" }))
      .task("second", task, () => ({ value: "b" }))
      .output(({ tasks }) => ({
        values: [tasks.first.output.value, tasks.second.output.value],
      }))
      .define();

    expect(buildWorkflow(workflow).plan.nodes).toMatchObject([
      { nodeId: "work:1", dependsOn: [] },
      { nodeId: "work:2", dependsOn: [] },
    ]);
  });
});
