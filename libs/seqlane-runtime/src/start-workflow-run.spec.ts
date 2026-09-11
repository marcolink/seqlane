// @test-scope ./start-workflow-run.ts
import {
  buildWorkflow,
  createFlow,
  defineTask,
  type SeqlaneEvent,
} from "@seqlane/core";
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
  it("validates workflow input before resolving the runtime", async () => {
    const { sink: eventSink, events } = createSink();
    const handle = startWorkflowRun({
      workflow: buildWorkflow(workflow),
      input: null,
      runtime: { id: "http://invalid.invalid" },
      events: eventSink,
    });
    const outcome = await handle.outcome;
    expect(outcome.status).toBe("failed");
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "run.failed" });
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
      runtime: { id: "local" },
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
      runtime: { id: "local" },
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
      runtime: { id: "local" },
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
