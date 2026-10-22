// @test-scope ./effect-plan.ts
// @test-scope ./effect-choice.ts
// @test-scope ../compile/compile-node-step.ts
// @test-scope ../invocation/invocation-execution.ts
// @test-scope ../session/session-preflight.ts

import {
  buildWorkflow,
  createFlow,
  defineTask,
  type SeqlaneEvent,
} from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Effect } from "effect";
import { createEffectPlanProgram } from "./effect-plan.js";

describe("choice input failure lifecycle", () => {
  it.each([
    { kind: "task", select: true },
    { kind: "task", select: false },
    { kind: "workflow", select: true },
    { kind: "workflow", select: false },
  ])(
    "fails invalid selected $kind input without starting or admitting it (condition $select)",
    async ({ kind, select }) => {
      const inputSchema = z.object({ value: z.string().min(1) });
      const outputSchema = z.object({ value: z.string() });
      const execute = vi.fn(async () => ({ value: "unexpected" }));
      const task = defineTask({
        id: "requires-value",
        input: inputSchema,
        output: outputSchema,
        execute,
      });
      const child = createFlow({
        id: "requires-value-workflow",
        input: inputSchema,
        output: outputSchema,
      })
        .task("process", task, ({ input }) => ({ value: input.value }))
        .output(({ tasks }) => tasks.process.output)
        .define();
      const choice = createFlow({
        id: "choice-invalid-input",
        input: z.object({ select: z.boolean(), value: z.string() }),
        output: outputSchema,
      }).when(({ input }) => input.select);
      const declaration =
        kind === "task"
          ? choice
              .task("decision", task, ({ input }) => ({ value: input.value }))
              .otherwise(task, ({ input }) => ({ value: input.value }))
          : choice
              .task("decision", child, ({ input }) => ({ value: input.value }))
              .otherwise(child, ({ input }) => ({ value: input.value }));
      const built = buildWorkflow(
        declaration.output(({ tasks }) => tasks.decision.output).define(),
      );
      const executeModel = vi.fn(async () => ({}));
      const resolveSession = vi.fn(async () => ({
        key: Symbol("unused-session"),
        executor: { execute: executeModel },
      }));
      const events: SeqlaneEvent[] = [];
      const sink = { emit: (event: SeqlaneEvent) => events.push(event) };
      const input = { select, value: "" };
      const program = createEffectPlanProgram({
        workflow: built,
        input,
        signal: new AbortController().signal,
        workId: "input-work",
        runId: "input-run",
        createInvocationId: (nodeId) => nodeId ?? "input-invocation",
        events: sink,
        resolveExecution: async () => ({
          taskDefinitions: built.taskDefinitions,
          workspaceIdentities: new Map(),
          executors: { agent: () => ({ execute: executeModel }) },
          sessionResolver: { resolve: resolveSession },
          workspaceResources: new Map(),
        }),
      });
      await expect(Effect.runPromise(program)).resolves.toMatchObject({
        status: "failed",
      });
      const selectedId = `choice:1:${select ? "then" : "else"}`;
      for (const invocationId of [selectedId, "choice:1"]) {
        expect(
          events.filter(
            (event) =>
              event.type === "invocation.failed" &&
              event.invocationId === invocationId,
          ),
        ).toHaveLength(1);
      }
      // Input failure happens before any start or admission progress.
      expect(
        events
          .filter(
            (event) =>
              "invocationId" in event && event.invocationId === selectedId,
          )
          .map(({ type }) => type),
      ).toEqual(["invocation.created", "invocation.failed"]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "invocation.failed",
          invocationId: selectedId,
          error: expect.objectContaining({ cause: expect.any(z.ZodError) }),
          disposition: "fail_run",
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "invocation.skipped",
          invocationId: `choice:1:${select ? "else" : "then"}`,
          reason: "Choice arm not selected",
        }),
      );
      expect(execute).not.toHaveBeenCalled();
      expect(resolveSession).not.toHaveBeenCalled();
      expect(executeModel).not.toHaveBeenCalled();
    },
  );
});
