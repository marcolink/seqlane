// @test-scope ./start-workflow-run.ts
import { buildWorkflow, createFlow, defineTask } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { startWorkflowRun } from "./start-workflow-run.js";

const inputSchema = {
  parse: (value: unknown) => {
    if (typeof value !== "object" || value === null || !("value" in value))
      throw new TypeError("value is required");
    return value as { value: string };
  },
};
const outputSchema = { parse: (value: unknown) => value as { value: string } };
const localTask = defineTask({
  id: "direct.local",
  workspace: "shared",
  input: inputSchema,
  output: outputSchema,
  execute: async ({ value }: { value: string }) => ({ value }),
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
  const events: unknown[] = [];
  return { events, sink: { emit: (event: unknown) => events.push(event) } };
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
          execute: async (value: { value: string }) => {
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
});
