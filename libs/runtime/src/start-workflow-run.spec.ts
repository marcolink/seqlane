// @test-scope ./start-workflow-run.ts
import {
  buildWorkflow,
  createFlow,
  defineAgentTask,
  defineTask,
  type SeqlaneEvent,
} from "@seqlane/core";
import type { AgentRuntime } from "@seqlane/agent-adapter";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startWorkflowRun } from "./start-workflow-run.js";

const inputSchema = z.object({ value: z.string() });
const outputSchema = z.object({ value: z.string() });
const localTask = defineTask({
  id: "direct.local",
  input: inputSchema,
  output: outputSchema,
  execute: async ({ input: { value } }) => ({ value }),
});
const workflow = createFlow({
  id: "direct-runtime-test",
  input: inputSchema,
  output: outputSchema,
})
  .task("local", localTask, ({ input }) => ({ value: input.value }))
  .output(({ tasks }) => tasks.local.output)
  .define();

function createSink() {
  const events: SeqlaneEvent[] = [];
  return {
    events,
    sink: { emit: (event: SeqlaneEvent) => events.push(event) },
  };
}

describe("startWorkflowRun", () => {
  it("accepts a pre-bootstrapped agent runtime without adapter configuration", async () => {
    const agentTask = defineAgentTask({
      id: "direct.agent",
      input: inputSchema,
      output: outputSchema,
      goal: () => "complete task",
    });
    const agentWorkflow = createFlow({
      id: "direct-agent-runtime",
      input: inputSchema,
      output: outputSchema,
    })
      .task("agent", agentTask, ({ input }) => input)
      .output(({ tasks }) => tasks.agent.output)
      .define();
    let adaptersCreated = 0;
    const agentRuntime: AgentRuntime = {
      identity: "fixture",
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: false,
        checkpoint: false,
        fork: false,
        activity: false,
        sessionUi: false,
      },
      createAdapter: () => {
        adaptersCreated += 1;
        return {
          capabilities: agentRuntime.capabilities,
          execute: async ({ onExecutionStarted }) => {
            onExecutionStarted();
            return { value: "complete" };
          },
        };
      },
      redactAdapter: (adapter) => adapter,
    };

    const handle = startWorkflowRun({
      workflow: buildWorkflow(agentWorkflow),
      input: { value: "input" },
      workspace: process.cwd(),
      agentRuntime,
      events: { emit: () => undefined },
    });

    await expect(handle.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: { value: "complete" },
    });
    expect(adaptersCreated).toBe(1);
  });

  it("declares no concrete adapter package in any dependency section", () => {
    const dependencySection = z.record(z.string(), z.string()).optional();
    const manifest = z
      .object({
        dependencies: dependencySection,
        devDependencies: dependencySection,
        optionalDependencies: dependencySection,
        peerDependencies: dependencySection,
      })
      .parse(
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ),
      );
    const declaredDependencies = Object.values(manifest).flatMap((section) =>
      Object.keys(section ?? {}),
    );
    const concreteAdapterDependencies = declaredDependencies.filter(
      (dependency) =>
        dependency.startsWith("@seqlane/") &&
        dependency.endsWith("-adapter") &&
        dependency !== "@seqlane/agent-adapter",
    );

    expect(concreteAdapterDependencies).toEqual([]);
  });

  it("validates workflow input before starting an agent runtime", async () => {
    const { sink: eventSink, events } = createSink();
    const handle = startWorkflowRun({
      workflow: buildWorkflow(workflow),
      input: null,
      workspace: process.cwd(),
      events: eventSink,
    });
    const outcome = await handle.outcome;
    expect(outcome.status).toBe("failed");
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "run.failed" });
  });

  it("closes a direct runtime when workflow input is invalid", async () => {
    let closed = 0;
    const agentRuntime: AgentRuntime = {
      identity: "fixture",
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: false,
        checkpoint: false,
        fork: false,
        activity: false,
        sessionUi: false,
      },
      createAdapter: () => {
        throw new Error("Invalid input must not create an adapter");
      },
      redactAdapter: (adapter) => adapter,
      close: async () => {
        closed += 1;
      },
    };

    const handle = startWorkflowRun({
      workflow: buildWorkflow(workflow),
      input: null,
      workspace: process.cwd(),
      agentRuntime,
      events: { emit: () => undefined },
    });

    await expect(handle.outcome).resolves.toMatchObject({
      status: "failed",
    });
    expect(closed).toBe(1);
  });

  it("rejects a direct runtime with standalone execution", async () => {
    const agentRuntime: AgentRuntime = {
      identity: "fixture",
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: false,
        checkpoint: false,
        fork: false,
        activity: false,
        sessionUi: false,
      },
      createAdapter: () => {
        throw new Error("Standalone execution must not create an adapter");
      },
      redactAdapter: (adapter) => adapter,
    };

    const handle = startWorkflowRun({
      workflow: buildWorkflow(workflow),
      input: { value: "valid" },
      workspace: process.cwd(),
      agentRuntime,
      standalone: { adapter: "test-fixture", workspace: process.cwd() },
      events: { emit: () => undefined },
    });

    await expect(handle.outcome).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        cause: expect.objectContaining({
          message:
            "Select standalone execution or a direct agent runtime, not both",
        }),
      }),
    });
  });

  it("supports caller identities and cancellation before task work", async () => {
    let executed = false;
    const cancellationWorkflow = createFlow({
      id: "cancel",
      input: inputSchema,
      output: outputSchema,
    })
      .task(
        "local",
        defineTask({
          ...localTask,
          execute: async ({ input: value }) => {
            executed = true;
            return value;
          },
        }),
        ({ input }) => ({ value: input.value }),
      )
      .output(({ tasks }) => tasks.local.output)
      .define();
    const { sink: eventSink, events } = createSink();
    const handle = startWorkflowRun({
      workflow: buildWorkflow(cancellationWorkflow),
      input: { value: "ok" },
      workspace: process.cwd(),
      events: eventSink,
      identity: { workId: "work-fixed", runId: "run-fixed" },
    });
    await handle.cancel();
    const outcome = await handle.outcome;
    expect(outcome).toEqual({ status: "cancelled" });
    expect(executed).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        type: "run.started",
        workId: "work-fixed",
        runId: "run-fixed",
      }),
      expect.objectContaining({
        type: "run.cancelled",
        workId: "work-fixed",
        runId: "run-fixed",
      }),
    ]);
  });

  it("executes deterministic nested workflows through the public runner", async () => {
    const childTask = defineTask({
      id: "direct.child-task",
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async ({ input }) => ({ result: input.value + 1 }),
    });
    const child = createFlow({
      id: "direct.child-workflow",
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.number() }),
    })
      .task("increment", childTask, ({ input }) => input)
      .output(({ tasks }) => tasks.increment.output)
      .define();
    const parent = createFlow({
      id: "direct.parent-workflow",
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.number() }),
    })
      .task("child", child, ({ input }) => input)
      .output(({ tasks }) => tasks.child.output)
      .define();
    const { sink: eventSink, events } = createSink();

    const handle = startWorkflowRun({
      workflow: buildWorkflow(parent),
      input: { value: 2 },
      workspace: process.cwd(),
      events: eventSink,
      identity: { workId: "direct-work", runId: "direct-run" },
    });

    await expect(handle.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: { result: 3 },
    });

    const created = events.filter(
      (event): event is Extract<SeqlaneEvent, { type: "invocation.created" }> =>
        event.type === "invocation.created",
    );
    const parentInvocation = created.find(
      (event) => event.kind === "workflow" && event.label === child.id,
    );
    if (parentInvocation === undefined) {
      throw new Error("Expected nested workflow invocation event");
    }
    expect(created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentInvocationId: parentInvocation.invocationId,
          kind: "task",
          label: childTask.id,
        }),
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      type: "run.succeeded",
      workId: "direct-work",
      runId: "direct-run",
      output: { result: 3 },
    });
  });

  it("preserves a typed failure when terminal event delivery keeps throwing", async () => {
    let eventCount = 0;
    const handle = startWorkflowRun({
      workflow: buildWorkflow(workflow),
      input: null,
      workspace: process.cwd(),
      events: {
        emit: () => {
          eventCount += 1;
          if (eventCount > 1) throw new Error("event sink unavailable");
        },
      },
    });

    const outcome = await handle.outcome;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.category).toBe("RuntimeError");
    expect(outcome.error.cause).toBeInstanceOf(Error);
    expect(outcome.error.cause).toBeInstanceOf(z.ZodError);
    expect((outcome.error.cause as z.ZodError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_type",
          path: [],
        }),
      ]),
    );
    expect((outcome.error.cause as Error).message).not.toContain(
      "event sink unavailable",
    );
  });
});
