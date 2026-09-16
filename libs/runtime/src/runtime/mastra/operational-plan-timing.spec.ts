// @test-scope ./operational-host.ts
import { expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { createOperationalWorkflow } from "./operational-host.js";
const preflight = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../execution/model-preflight.js", () => ({
  preflightCompiledWorkflowModels: preflight.run,
}));

it("publishes planned rows before model preflight finishes", async () => {
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  preflight.run.mockReturnValue(pending);
  const emitPlan = vi.fn();
  const execute = vi.fn(async () => ({}));
  const registration = createOperationalWorkflow({
    key: "repository:plan-timing",
    plan: {
      workflow: { id: "plan-timing" },
      nodes: [
        {
          type: "task",
          nodeId: "task:1",
          taskId: "task",
          workspace: "shared",
          input: {},
          dependsOn: [],
        },
      ],
      output: {},
    },
    taskDefinitions: new Map([
      [
        "task",
        { id: "task", input: z.unknown(), output: z.unknown(), execute },
      ],
    ]),
    eventSink: () => ({ emit: () => undefined, emitPlan }),
  });
  const workflow = registration.workflow as AnyWorkflow;
  const run = await workflow.createRun({
    runId: "pending-plan",
    resourceId: "work",
    shouldPersistSnapshot: () => false,
  });
  const requestContext = new RequestContext<unknown>([
    ["seqlane.runtimeId", "local"],
  ]);
  registration.prepareRunContext?.(requestContext, "work", "pending-plan");
  const result = run.start({ inputData: {}, requestContext });
  try {
    await vi.waitFor(() => expect(preflight.run).toHaveBeenCalled());
    expect(emitPlan).toHaveBeenCalledOnce();
    expect(emitPlan.mock.calls[0]?.[0].nodes).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  } finally {
    release();
    await result;
    await registration.terminate?.("pending-plan");
  }
});
