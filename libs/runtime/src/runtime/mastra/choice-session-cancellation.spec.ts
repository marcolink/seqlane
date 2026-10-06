// @test-scope ./mastra-execution.ts
// @test-scope ../compile/mastra-choice-compiler.ts

import { EventEmitter, once } from "node:events";
import type { SeqlaneEvent } from "@seqlane/core";
import {
  branch,
  buildWorkflow,
  createFlow,
  defineTask,
  reuse,
} from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resolveCompiledWorkflowSessions } from "../session/session-preflight.js";
import {
  createMastraPlanExecution,
  emitMastraInvocationTopology,
} from "./mastra-execution.js";

describe("choice cancellation during session admission", () => {
  it("reports selected isolated session resolution failure", async () => {
    const schema = z.object({ value: z.string() });
    const execute = vi.fn(async () => ({ value: "result" }));
    const task = defineTask({
      id: "isolated-choice-task",
      input: z.object({}),
      output: schema,
      execute,
    });
    const built = buildWorkflow(
      createFlow({
        id: "isolated-failure",
        input: z.object({ select: z.boolean() }),
        output: schema,
      })
        .when(({ input }) => input.select)
        .task("decision", task, () => ({}), { session: { type: "isolated" } })
        .otherwise(task, () => ({}))
        .output(({ tasks }) => tasks.decision.output)
        .define(),
    );
    const events: SeqlaneEvent[] = [];
    const sink = {
      emit: (event: SeqlaneEvent) => {
        events.push(event);
      },
    };
    const resolve = vi.fn(async () => {
      throw new Error("isolated resolver rejected");
    });
    const executeModel = vi.fn(async () => ({}));
    const execution = createMastraPlanExecution({
      plan: built.plan,
      workflow: built.workflow,
      workflowInput: { select: true },
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId ?? "invocation",
      taskDefinitions: built.taskDefinitions,
      workflowDefinitions: built.workflowDefinitions,
      executors: { agent: () => ({ execute: executeModel }) },
      sessionResolver: { resolve },
      workspaceResources: new Map(),
      events: sink,
    });
    await resolveCompiledWorkflowSessions(execution.prepared);
    emitMastraInvocationTopology(execution.compiled, execution.prepared, sink);
    const active = await execution.runtime.start({
      workflowKey: built.plan.workflow.id,
      input: { select: true },
      workId: "work",
      runId: "run",
    });
    await active.outcome;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(
      events.filter(
        (event) =>
          event.type === "invocation.failed" &&
          event.invocationId === "choice:1:then",
      ),
    ).toHaveLength(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "invocation.skipped",
        invocationId: "choice:1:then",
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(executeModel).not.toHaveBeenCalled();
  });

  it.each([
    { policyName: "reuse", sessionPolicy: reuse },
    { policyName: "fork", sessionPolicy: branch },
  ])(
    "cancels a task waiting to $policyName its source session",
    async ({ sessionPolicy }) => {
      const signals = new EventEmitter();
      const sourceStarted = once(signals, "source-started");
      const sourceReleased = once(signals, "source-released");
      const waitingForSource = once(signals, "waiting-for-source");
      const events: SeqlaneEvent[] = [];
      const schema = z.object({ value: z.string() });
      const source = defineTask({
        id: "session-source",
        input: z.object({}),
        output: schema,
        execute: async () => {
          signals.emit("source-started");
          await sourceReleased;
          return { value: "source" };
        },
      });
      const selectedExecute = vi.fn(async () => ({ value: "selected" }));
      const fallbackExecute = vi.fn(async () => ({ value: "fallback" }));
      const selected = defineTask({
        id: "selected-task",
        input: z.object({}),
        output: schema,
        execute: selectedExecute,
      });
      const fallback = defineTask({
        id: "fallback-task",
        input: z.object({}),
        output: schema,
        execute: fallbackExecute,
      });
      const built = buildWorkflow(
        createFlow({
          id: "cancel-session-choice",
          input: z.object({ select: z.boolean() }),
          output: schema,
        })
          .task("source", source, () => ({}), {
            session: { type: "isolated" },
            workspace: "shared",
          })
          .when(({ input }) => input.select)
          .task("decision", selected, () => ({}), {
            session: ({ tasks }) => sessionPolicy(tasks.source.session),
            workspace: "shared",
          })
          .otherwise(fallback, () => ({}), { workspace: "shared" })
          .output(({ tasks }) => tasks.decision.output)
          .define(),
      );
      const executeModel = vi.fn(async () => ({}));
      const fork = vi.fn(async () => ({
        key: Symbol("fork"),
        executor: { execute: executeModel },
      }));
      const sink = {
        emit: (event: SeqlaneEvent) => {
          events.push(event);
        },
      };
      const execution = createMastraPlanExecution({
        plan: built.plan,
        workflow: built.workflow,
        workflowInput: { select: true },
        workId: "cancel-work",
        runId: "cancel-run",
        createInvocationId: (nodeId) => nodeId ?? "cancel-invocation",
        taskDefinitions: built.taskDefinitions,
        workflowDefinitions: built.workflowDefinitions,
        executors: { agent: () => ({ execute: executeModel }) },
        sessionResolver: {
          resolve: async () => ({
            key: Symbol("source"),
            executor: { execute: executeModel },
            checkpoint: async () => "source-checkpoint",
            fork,
          }),
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
      const gate = execution.prepared.context.choiceSourceGate;
      const wait = gate.wait.bind(gate);
      // Synchronize cancellation with the real session wait, without timers.
      vi.spyOn(gate, "wait").mockImplementation((sourceNodeId, signal) => {
        signals.emit("waiting-for-source");
        signal.addEventListener(
          "abort",
          () => signals.emit("source-released"),
          {
            once: true,
          },
        );
        return wait(sourceNodeId, signal);
      });
      const active = await execution.runtime.start({
        workflowKey: built.plan.workflow.id,
        input: { select: true },
        workId: "cancel-work",
        runId: "cancel-run",
      });
      try {
        await Promise.all([sourceStarted, waitingForSource]);
        await active.cancel();
        await expect(active.outcome).resolves.toEqual({ status: "cancelled" });
        for (const invocationId of ["choice:1:then", "choice:1"]) {
          expect(
            events.filter(
              (event) =>
                event.type === "invocation.cancelled" &&
                event.invocationId === invocationId,
            ),
          ).toHaveLength(1);
        }
        expect(events).not.toContainEqual(
          expect.objectContaining({ type: "invocation.failed" }),
        );
        expect(events).not.toContainEqual(
          expect.objectContaining({
            type: "invocation.started",
            invocationId: "choice:1:then",
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
        expect(fork).not.toHaveBeenCalled();
        expect(executeModel).not.toHaveBeenCalled();
      } finally {
        signals.emit("source-released");
        await active.cancel();
      }
    },
  );
});
