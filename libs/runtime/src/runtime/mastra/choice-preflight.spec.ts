// @test-scope ./mastra-execution.ts
// @test-scope ../compile/mastra-choice-compiler.ts
// @test-scope ../execution/model-preflight.ts
// @test-scope ../session/session-preflight.ts

import {
  buildWorkflow,
  createFlow,
  defineTask,
  type SeqlaneEvent,
} from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  resolveCompiledWorkflowSessions,
  UnsupportedSessionCapabilityError,
} from "../session/session-preflight.js";
import { UnavailableExecutorModelError } from "../execution/model-preflight.js";
import {
  createMastraPlanExecution,
  emitMastraInvocationTopology,
} from "./mastra-execution.js";

describe("choice preflight lifecycle", () => {
  it.each(["model", "session"] as const)(
    "fails %s preflight without starting or admitting the selected arm",
    async (failure) => {
      const schema = z.object({ value: z.string() });
      const selectedExecute = vi.fn(async () => ({ value: "selected" }));
      const fallbackExecute = vi.fn(async () => ({ value: "fallback" }));
      const selected = defineTask({
        id: "preflight-selected",
        input: z.object({}),
        output: schema,
        execute: selectedExecute,
      });
      const fallback = defineTask({
        id: "preflight-fallback",
        input: z.object({}),
        output: schema,
        execute: fallbackExecute,
      });
      const built = buildWorkflow(
        createFlow({
          id: "choice-preflight",
          input: z.object({ select: z.boolean() }),
          output: schema,
        })
          .when(({ input }) => input.select)
          .task("decision", selected, () => ({}), {
            session: {
              type: "isolated",
              model: {
                model: {
                  provider: "test",
                  model: failure === "model" ? "unavailable" : "available",
                },
              },
            },
          })
          .otherwise(fallback, () => ({}))
          .output(({ tasks }) => tasks.decision.output)
          .define(),
      );
      const executeModel = vi.fn(async () => ({}));
      const resolve = vi.fn(async () => ({
        key: Symbol("selected"),
        executor: { execute: executeModel },
      }));
      const events: SeqlaneEvent[] = [];
      const sink = {
        emit: (event: SeqlaneEvent) => {
          events.push(event);
        },
      };
      const execution = createMastraPlanExecution({
        plan: built.plan,
        workflow: built.workflow,
        workflowInput: { select: true },
        workId: "preflight-work",
        runId: `preflight-${failure}`,
        createInvocationId: (nodeId) => nodeId ?? "preflight-invocation",
        taskDefinitions: built.taskDefinitions,
        workflowDefinitions: built.workflowDefinitions,
        executors: { agent: () => ({ execute: executeModel }) },
        sessionResolver: {
          adapterCapabilities: {
            execute: true,
            modelSelection: true,
            structuredOutput: false,
            sessionReuse: true,
            checkpoint: true,
            fork: true,
            activity: false,
            sessionUi: false,
          },
          modelCapabilities: {
            executor: "test",
            listModels: async () => [{ provider: "test", model: "available" }],
            resolveDefaultModel: async () => ({
              model: { provider: "test", model: "available" },
            }),
          },
          resolve,
        },
        workspaceResources: new Map(),
        events: sink,
      });
      await resolveCompiledWorkflowSessions(execution.prepared);
      emitMastraInvocationTopology(
        execution.compiled,
        execution.prepared,
        sink,
      );
      const active = await execution.runtime.start({
        workflowKey: built.plan.workflow.id,
        input: { select: true },
        workId: "preflight-work",
        runId: `preflight-${failure}`,
      });
      await expect(active.outcome).resolves.toMatchObject({ status: "failed" });
      for (const invocationId of ["choice:1:then", "choice:1"]) {
        expect(
          events.filter(
            (event) =>
              event.type === "invocation.failed" &&
              event.invocationId === invocationId,
          ),
        ).toHaveLength(1);
      }
      const failedArm = events.find(
        (event) =>
          event.type === "invocation.failed" &&
          event.invocationId === "choice:1:then",
      );
      if (failedArm?.type !== "invocation.failed")
        throw new Error("Missing arm failure");
      expect(failedArm.error.cause).toBeInstanceOf(
        failure === "model"
          ? UnavailableExecutorModelError
          : UnsupportedSessionCapabilityError,
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: "invocation.started",
          invocationId: "choice:1:then",
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: "invocation.progress",
          invocationId: "choice:1:then",
          phase: "workspace_admitted",
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "invocation.skipped",
          invocationId: "choice:1:else",
          reason: "Choice arm not selected",
        }),
      );
      expect(selectedExecute).not.toHaveBeenCalled();
      expect(fallbackExecute).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(executeModel).not.toHaveBeenCalled();
    },
  );
});
