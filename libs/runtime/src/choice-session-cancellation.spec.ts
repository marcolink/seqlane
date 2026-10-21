// @test-scope ./start-workflow-run.ts
// @test-scope ./runtime/execution/effect-plan.ts
// @test-scope ./runtime/execution/effect-choice.ts
// @test-scope ./runtime/invocation/task-admission.ts

import type {
  AgentAdapter,
  AgentAdapterCapabilities,
  AgentRuntime,
} from "@seqlane/agent-adapter";
import {
  buildWorkflow,
  createFlow,
  defineAgentTask,
  fork,
  isolated,
  reuse,
  type SeqlaneEvent,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createEffectPlanProgram } from "./runtime/execution/effect-plan.js";
import { startWorkflowRun } from "./start-workflow-run.js";

const capabilities: AgentAdapterCapabilities = {
  execute: true,
  modelSelection: false,
  structuredOutput: true,
  sessionReuse: true,
  checkpoint: true,
  fork: true,
  activity: false,
  sessionUi: false,
};

function deferred<A = void>() {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settleBeforeTimeout<A>(
  promise: Promise<A>,
  description: string,
  events: readonly SeqlaneEvent[],
): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${description} timed out: ${JSON.stringify(events)}`),
            ),
          3_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function eventSink() {
  const events: SeqlaneEvent[] = [];
  const listeners = new Set<(event: SeqlaneEvent) => void>();
  return {
    events,
    sink: {
      emit(event: SeqlaneEvent) {
        events.push(event);
        for (const listener of listeners) listener(event);
      },
    },
    waitFor(predicate: (current: readonly SeqlaneEvent[]) => boolean) {
      if (predicate(events)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const listener = (): void => {
          if (!predicate(events)) return;
          listeners.delete(listener);
          resolve();
        };
        listeners.add(listener);
      });
    },
  };
}

function runtimeFor(
  sourceStarted: ReturnType<typeof deferred<void>>,
  releaseSource: ReturnType<typeof deferred<void>>,
  executeTask: (taskId: string) => void,
  forkCalls: { count: number },
): AgentRuntime {
  const adapter: AgentAdapter = {
    capabilities,
    execute: async ({ task, signal, onExecutionStarted }) => {
      onExecutionStarted();
      executeTask(task.id);
      if (task.id === "session-source") {
        sourceStarted.resolve();
        await Promise.race([
          releaseSource.promise,
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        ]);
      }
      return { value: task.id };
    },
    captureCheckpoint: async () => "checkpoint",
    fork: async (request) => {
      void request;
      forkCalls.count += 1;
      return adapter;
    },
  };
  return {
    identity: "session-cancellation-fixture",
    capabilities,
    createAdapter: () => adapter,
    redactAdapter: (value) => value,
  };
}

describe("choice cancellation during session admission", () => {
  it.each([
    { policyName: "reuse", sessionPolicy: reuse },
    { policyName: "fork", sessionPolicy: fork },
  ])(
    "cancels a selected task waiting to $policyName its source session",
    async ({ sessionPolicy }) => {
      const sourceStarted = deferred();
      const releaseSource = deferred();
      const forkCalls = { count: 0 };
      const calledTaskIds: string[] = [];
      const schema = z.object({ value: z.string() });
      const source = defineAgentTask({
        id: "session-source",
        input: z.object({}),
        output: schema,
        goal: () => "Hold the source session until cancellation.",
      });
      const selected = defineAgentTask({
        id: "selected-task",
        input: z.object({}),
        output: schema,
        goal: () => "Use the source session.",
      });
      const fallback = defineAgentTask({
        id: "fallback-task",
        input: z.object({}),
        output: schema,
        goal: () => "Use the unselected fallback.",
      });
      const workflow = buildWorkflow(
        createFlow({
          id: "cancel-session-choice",
          input: z.object({ select: z.boolean() }),
          output: schema,
        })
          .task("source", source, () => ({}), {
            session: isolated(),
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
      const { events, sink, waitFor } = eventSink();
      const runtime = runtimeFor(
        sourceStarted,
        releaseSource,
        (taskId) => calledTaskIds.push(taskId),
        forkCalls,
      );
      const run = startWorkflowRun(
        {
          workflow,
          input: { select: true },
          agentRuntime: runtime,
          events: sink,
        },
        { program: createEffectPlanProgram },
      );
      try {
        await settleBeforeTimeout(
          sourceStarted.promise,
          "source start",
          events,
        );
        await settleBeforeTimeout(
          waitFor((current) =>
            current.some(
              (event) =>
                event.type === "invocation.created" &&
                event.planNodeId === "choice:1:then",
            ),
          ),
          "selected invocation creation",
          events,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        const selectedInvocation = events.find(
          (event) =>
            event.type === "invocation.created" &&
            event.planNodeId === "choice:1:then",
        );
        expect(selectedInvocation?.type).toBe("invocation.created");
        if (selectedInvocation?.type !== "invocation.created")
          throw new Error("Missing selected invocation");
        expect(events).not.toContainEqual(
          expect.objectContaining({
            type: "invocation.started",
            invocationId: selectedInvocation.invocationId,
          }),
        );

        await run.cancel();
        await expect(run.outcome).resolves.toMatchObject({
          status: "cancelled",
        });
        const choiceInvocation = events.find(
          (event) =>
            event.type === "invocation.created" &&
            event.planNodeId === "choice:1",
        );
        if (choiceInvocation?.type !== "invocation.created")
          throw new Error("Missing choice invocation");
        for (const invocationId of [
          selectedInvocation.invocationId,
          choiceInvocation.invocationId,
        ]) {
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
            invocationId: selectedInvocation.invocationId,
          }),
        );
        const fallbackInvocation = events.find(
          (event) =>
            event.type === "invocation.created" &&
            event.planNodeId === "choice:1:else",
        );
        expect(fallbackInvocation?.type).toBe("invocation.created");
        if (fallbackInvocation?.type !== "invocation.created")
          throw new Error("Missing fallback invocation");
        expect(
          events.filter(
            (event) =>
              event.type === "invocation.skipped" &&
              event.invocationId === fallbackInvocation.invocationId &&
              event.reason === "Choice arm not selected",
          ),
        ).toHaveLength(1);
        expect(calledTaskIds).toEqual(["session-source"]);
        expect(forkCalls.count).toBe(0);
      } finally {
        releaseSource.resolve();
        await run.cancel();
      }
    },
  );
});
