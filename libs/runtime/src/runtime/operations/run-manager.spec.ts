// @test-scope ./run-manager.ts
// @test-scope ./sqlite-store.ts
// @test-scope ./registration.ts
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Fiber } from "effect";
import {
  buildWorkflow,
  createFlow,
  type Plan,
  type TaskDefinition,
} from "@seqlane/core";
import { z } from "zod";
import { createOperationalWorkflow } from "./registration.js";
import { createOperationalRunManager } from "./run-manager.js";
import { OperationalAdmissionError } from "./run-manager.js";
import { openOperationalStore } from "./sqlite-store.js";
import type { OperationalStore } from "./sqlite-store.js";
import { seqlaneExecutionEventSchema } from "@seqlane/protocol";

describe("hosted native run manager", () => {
  let close: (() => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await shutdown?.();
    await close?.();
    close = undefined;
    shutdown = undefined;
  });

  it("persists the actual result, canonical events, and a correlated native trace", async () => {
    const input = z
      .string()
      .transform((value) => ({ value, length: value.length }));
    const output = z.strictObject({ value: z.string(), length: z.number() });
    const authored = createFlow({ id: "hosted-echo", input, output })
      .output(({ input: value }) => value)
      .define();
    const built = buildWorkflow(authored);
    const coreEvents: string[] = [];
    const emittedPlans: string[] = [];
    const workflow = createOperationalWorkflow({
      key: "echo",
      plan: built.plan,
      workflow: authored,
      taskDefinitions: built.taskDefinitions,
      validatorDefinitions: built.validatorDefinitions,
      workflowDefinitions: built.workflowDefinitions,
      eventSink: () => ({
        emit: (event) => {
          coreEvents.push(event.type);
        },
        emitPlan: (_plan, _workId, runId) => {
          emittedPlans.push(runId);
        },
      }),
    });
    const store = await openOperationalStore("file::memory:");
    close = () => store.close();
    const manager = createOperationalRunManager({
      workflows: [workflow],
      store,
    });
    shutdown = () => manager.shutdown();
    expect(manager.workflows[0]?.input.schema).toMatchObject({
      type: "string",
    });
    expect(manager.workflows[0]?.output.schema).toMatchObject({
      type: "object",
      properties: { length: { type: "number" } },
    });

    const reference = await manager.start("echo", { version: 1, input: "" });
    await expect
      .poll(async () => await manager.status(reference.runId))
      .toMatchObject({ status: "succeeded" });
    const status = await manager.status(reference.runId);
    expect(status).toMatchObject({
      status: "succeeded",
      output: { value: "", length: 0 },
      completeness: { inspection: "complete" },
    });

    const events = await manager.events(reference.runId, {
      version: 1,
      afterSequence: 0,
      limit: 100,
    });
    expect(events?.events.map(({ event }) => event.type)).toEqual([
      "run.started",
      "run.plan",
      "run.succeeded",
    ]);
    expect(events?.events.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(coreEvents).toEqual(["run.started", "run.succeeded"]);
    expect(emittedPlans).toEqual([reference.runId]);
    const trace = await manager.trace(reference.runId);
    expect(trace.completeness).toEqual({ inspection: "complete" });
    expect(trace.spans.some((span) => span.name === "seqlane.hosted.run")).toBe(
      true,
    );
    expect(trace.spans.every((span) => span.traceId === trace.traceId)).toBe(
      true,
    );
  });

  it("keeps a successful task result when terminal event storage fails", async () => {
    const input = z.string();
    const authored = createFlow({
      id: "hosted-storage-failure",
      input,
      output: input,
    })
      .output(({ input: value }) => value)
      .define();
    const built = buildWorkflow(authored);
    const workflow = createOperationalWorkflow({
      key: "failure",
      plan: built.plan,
      workflow: authored,
      taskDefinitions: built.taskDefinitions,
      validatorDefinitions: built.validatorDefinitions,
      workflowDefinitions: built.workflowDefinitions,
    });
    const store = await openOperationalStore("file::memory:");
    close = () => store.close();
    const failingStore: OperationalStore = {
      ...store,
      appendEvent: async (runId, value) => {
        const event = seqlaneExecutionEventSchema.parse(value);
        if (event.type === "run.succeeded")
          throw new Error("simulated storage failure");
        await store.appendEvent(runId, event);
      },
    };
    const manager = createOperationalRunManager({
      workflows: [workflow],
      store: failingStore,
    });
    shutdown = () => manager.shutdown();

    const reference = await manager.start("failure", { version: 1, input: "" });
    await expect
      .poll(async () => await manager.status(reference.runId))
      .toMatchObject({ status: "succeeded" });
    expect(await manager.status(reference.runId)).toMatchObject({
      status: "succeeded",
      output: "",
      completeness: {
        inspection: "incomplete",
        storageError: { category: "RuntimeError" },
      },
    });
    expect(await store.status(reference.runId)).toMatchObject({
      status: "succeeded",
      output: "",
      completeness: { inspection: "incomplete" },
    });
  });

  it("aborts and drains an active task when canonical event delivery fails", async () => {
    const input = z.string();
    const plan: Plan = {
      workflow: { id: "hosted-active-storage-failure" },
      nodes: [
        {
          type: "task",
          taskId: "hosted-active-storage-failure.task",
          nodeId: "hosted-active-storage-failure.task:1",
          workspace: "exclusive",
          input: { type: "ref", nodeId: "__seqlane_input", path: [] },
          dependsOn: [],
        },
      ],
      output: {
        type: "ref",
        nodeId: "hosted-active-storage-failure.task:1",
        path: [],
      },
    };
    let failObserved!: () => void;
    const eventFailure = new Promise<void>((resolve) => {
      failObserved = resolve;
    });
    const workflow = createOperationalWorkflow({
      key: "active-storage-failure",
      plan,
      workflow: { input, output: input },
      taskDefinitions: new Map<string, TaskDefinition<string, string>>([
        [
          "hosted-active-storage-failure.task",
          {
            id: "hosted-active-storage-failure.task",
            input,
            output: input,
            execute: async ({ input: value, signal }) => {
              await eventFailure;
              if (!signal.aborted)
                await new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  }),
                );
              return value;
            },
          },
        ],
      ]),
    });
    const store = await openOperationalStore("file::memory:");
    close = () => store.close();
    const failingStore: OperationalStore = {
      ...store,
      appendEvent: async (runId, value) => {
        const event = seqlaneExecutionEventSchema.parse(value);
        if (event.type === "invocation.input") {
          failObserved();
          throw new Error("simulated active event storage failure");
        }
        await store.appendEvent(runId, event);
      },
    };
    const manager = createOperationalRunManager({
      workflows: [workflow],
      store: failingStore,
    });
    shutdown = () => manager.shutdown();

    const reference = await manager.start("active-storage-failure", {
      version: 1,
      input: "active",
    });
    await expect
      .poll(async () => (await manager.status(reference.runId)).status)
      .toBe("failed");
    expect(await manager.status(reference.runId)).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining(
          "simulated active event storage failure",
        ),
      },
      completeness: {
        inspection: "incomplete",
        storageError: { message: "simulated active event storage failure" },
      },
    });
  });

  it.each([null, undefined])(
    "preserves a falsey event-store failure cause (%s)",
    async (cause) => {
      const input = z.string();
      const plan: Plan = {
        workflow: { id: "hosted-falsey-storage-failure" },
        nodes: [
          {
            type: "task",
            taskId: "hosted-falsey-storage-failure.task",
            nodeId: "hosted-falsey-storage-failure.task:1",
            workspace: "exclusive",
            input: { type: "ref", nodeId: "__seqlane_input", path: [] },
            dependsOn: [],
          },
        ],
        output: {
          type: "ref",
          nodeId: "hosted-falsey-storage-failure.task:1",
          path: [],
        },
      };
      let failObserved!: () => void;
      const eventFailure = new Promise<void>((resolve) => {
        failObserved = resolve;
      });
      const workflow = createOperationalWorkflow({
        key: "falsey-storage-failure",
        plan,
        workflow: { input, output: input },
        taskDefinitions: new Map<string, TaskDefinition<string, string>>([
          [
            "hosted-falsey-storage-failure.task",
            {
              id: "hosted-falsey-storage-failure.task",
              input,
              output: input,
              execute: async ({ input: value, signal }) => {
                await eventFailure;
                if (!signal.aborted)
                  await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => resolve(), {
                      once: true,
                    }),
                  );
                return value;
              },
            },
          ],
        ]),
      });
      const store = await openOperationalStore("file::memory:");
      close = () => store.close();
      let storedCause: unknown = "not observed";
      const failingStore: OperationalStore = {
        ...store,
        appendEvent: async (runId, value) => {
          const event = seqlaneExecutionEventSchema.parse(value);
          if (event.type === "invocation.input") {
            failObserved();
            throw cause;
          }
          await store.appendEvent(runId, event);
        },
        markIncomplete: async (value) => {
          storedCause = value.storageError;
          await store.markIncomplete(value);
        },
      };
      const manager = createOperationalRunManager({
        workflows: [workflow],
        store: failingStore,
      });
      shutdown = () => manager.shutdown();

      const reference = await manager.start("falsey-storage-failure", {
        version: 1,
        input: "active",
      });
      await expect
        .poll(async () => (await manager.status(reference.runId)).status)
        .toBe("failed");
      expect(storedCause).toBe(cause);
      expect(await manager.status(reference.runId)).toMatchObject({
        status: "failed",
        error: { category: "RuntimeError" },
        completeness: { inspection: "incomplete" },
      });
    },
  );

  it("forwards every core invocation event to the registered event sink", async () => {
    const input = z.string();
    const plan: Plan = {
      workflow: { id: "hosted-event-forwarding" },
      nodes: [
        {
          type: "task",
          taskId: "hosted-event-forwarding.task",
          nodeId: "hosted-event-forwarding.task:1",
          workspace: "exclusive",
          input: { type: "ref", nodeId: "__seqlane_input", path: [] },
          dependsOn: [],
        },
      ],
      output: {
        type: "ref",
        nodeId: "hosted-event-forwarding.task:1",
        path: [],
      },
    };
    const coreEvents: string[] = [];
    const workflow = createOperationalWorkflow({
      key: "forwarding",
      plan,
      workflow: { input, output: input },
      taskDefinitions: new Map([
        [
          "hosted-event-forwarding.task",
          {
            id: "hosted-event-forwarding.task",
            input,
            output: input,
            execute: async ({ input: value }) => value,
          },
        ],
      ]),
      eventSink: () => ({
        emit: (event) => {
          coreEvents.push(event.type);
        },
        emitPlan: () => undefined,
      }),
    });
    const store = await openOperationalStore("file::memory:");
    close = () => store.close();
    const manager = createOperationalRunManager({
      workflows: [workflow],
      store,
    });
    shutdown = () => manager.shutdown();

    const reference = await manager.start("forwarding", {
      version: 1,
      input: "task input",
    });
    await expect
      .poll(async () => (await manager.status(reference.runId)).status)
      .toBe("succeeded");
    expect(coreEvents).toEqual(
      expect.arrayContaining([
        "run.started",
        "invocation.created",
        "invocation.input",
        "invocation.started",
        "invocation.result",
        "invocation.succeeded",
        "run.succeeded",
      ]),
    );
  });

  it("settles and preserves the event when a registered sink throws", async () => {
    const input = z.string();
    const plan: Plan = {
      workflow: { id: "hosted-sink-failure" },
      nodes: [
        {
          type: "task",
          taskId: "hosted-sink-failure.task",
          nodeId: "hosted-sink-failure.task:1",
          workspace: "exclusive",
          input: { type: "ref", nodeId: "__seqlane_input", path: [] },
          dependsOn: [],
        },
      ],
      output: { type: "ref", nodeId: "hosted-sink-failure.task:1", path: [] },
    };
    const workflow = createOperationalWorkflow({
      key: "sink-failure",
      plan,
      workflow: { input, output: input },
      taskDefinitions: new Map([
        [
          "hosted-sink-failure.task",
          {
            id: "hosted-sink-failure.task",
            input,
            output: input,
            execute: async ({ input: value }) => value,
          },
        ],
      ]),
      eventSink: () => ({
        emit: (event) => {
          if (event.type === "invocation.input")
            throw new Error("event sink rejected input");
        },
        emitPlan: () => undefined,
      }),
    });
    const store = await openOperationalStore("file::memory:");
    close = () => store.close();
    const manager = createOperationalRunManager({
      workflows: [workflow],
      store,
    });
    shutdown = () => manager.shutdown();

    const reference = await manager.start("sink-failure", {
      version: 1,
      input: "value",
    });
    await expect
      .poll(async () => (await manager.status(reference.runId)).status)
      .toBe("failed");
    expect(await manager.status(reference.runId)).toMatchObject({
      error: { message: expect.stringContaining("event sink rejected input") },
    });
    expect(
      (
        await manager.events(reference.runId, {
          version: 1,
          afterSequence: 0,
          limit: 100,
        })
      )?.events.map(({ event }) => event.type),
    ).toContain("invocation.input");
  });

  it("waits for hosted run cleanup when invoke is interrupted", async () => {
    const authored = createFlow({
      id: "hosted-invoke-cancel",
      input: z.unknown(),
      output: z.unknown(),
    })
      .output(({ input }: { readonly input: unknown }) => input)
      .define();
    const built = buildWorkflow(authored);
    const workflow = createOperationalWorkflow({
      key: "invoke-cancel",
      plan: built.plan,
      workflow: authored,
      taskDefinitions: built.taskDefinitions,
      validatorDefinitions: built.validatorDefinitions,
      workflowDefinitions: built.workflowDefinitions,
    });
    const store = await openOperationalStore("file::memory:");
    close = () => store.close();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    const heldStore: OperationalStore = {
      ...store,
      setRunning: async (runId, updatedAt) => {
        active += 1;
        await blocked;
        await store.setRunning(runId, updatedAt);
      },
    };
    const manager = createOperationalRunManager({
      workflows: [workflow],
      store: heldStore,
    });
    shutdown = () => manager.shutdown();
    const fiber = Effect.runFork(
      manager.invoke("invoke-cancel", {
        version: 1,
        runId: "invoke-cancel-1",
        input: null,
      }),
    );
    await expect.poll(() => active).toBe(1);

    let interruptionSettled = false;
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interruptionSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(interruptionSettled).toBe(false);
    release();
    await interruption;
    expect(interruptionSettled).toBe(true);
    expect(await manager.status("invoke-cancel-1")).toMatchObject({
      status: "cancelled",
    });
  });

  it("does not launch an invoke cancelled while run admission is waiting on storage", async () => {
    const input = z.string();
    const plan: Plan = {
      workflow: { id: "invoke-admission-cancel" },
      nodes: [
        {
          type: "task",
          taskId: "invoke-admission-cancel.task",
          nodeId: "invoke-admission-cancel.task:1",
          workspace: "exclusive",
          input: { type: "ref", nodeId: "__seqlane_input", path: [] },
          dependsOn: [],
        },
      ],
      output: {
        type: "ref",
        nodeId: "invoke-admission-cancel.task:1",
        path: [],
      },
    };
    let externalStarts = 0;
    const workflow = createOperationalWorkflow({
      key: "invoke-admission-cancel",
      plan,
      workflow: { input, output: input },
      taskDefinitions: new Map([
        [
          "invoke-admission-cancel.task",
          {
            id: "invoke-admission-cancel.task",
            input,
            output: input,
            execute: async ({ input: value }) => {
              externalStarts += 1;
              return value;
            },
          },
        ],
      ]),
    });
    const store = await openOperationalStore("file::memory:");
    close = () => store.close();
    let enteredCreateRun!: () => void;
    let release!: () => void;
    const createRunEntered = new Promise<void>((resolve) => {
      enteredCreateRun = resolve;
    });
    const createRunBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldStore: OperationalStore = {
      ...store,
      createRun: async (value) => {
        enteredCreateRun();
        await createRunBlocked;
        await store.createRun(value);
      },
    };
    const manager = createOperationalRunManager({
      workflows: [workflow],
      store: heldStore,
    });
    shutdown = () => manager.shutdown();
    const fiber = Effect.runFork(
      manager.invoke("invoke-admission-cancel", {
        version: 1,
        runId: "invoke-admission-cancel-1",
        input: "value",
      }),
    );
    await createRunEntered;
    let interruptionSettled = false;
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interruptionSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(interruptionSettled).toBe(false);
    release();
    await interruption;
    await manager.shutdown();

    expect(externalStarts).toBe(0);
    expect(await store.status("invoke-admission-cancel-1")).toMatchObject({
      status: "cancelled",
    });
  });

  it("drains a start already waiting on storage before manager shutdown", async () => {
    const input = z.string();
    const plan: Plan = {
      workflow: { id: "shutdown-admission" },
      nodes: [
        {
          type: "task",
          taskId: "shutdown-admission.task",
          nodeId: "shutdown-admission.task:1",
          workspace: "exclusive",
          input: { type: "ref", nodeId: "__seqlane_input", path: [] },
          dependsOn: [],
        },
      ],
      output: { type: "ref", nodeId: "shutdown-admission.task:1", path: [] },
    };
    let externalStarts = 0;
    const workflow = createOperationalWorkflow({
      key: "shutdown-admission",
      plan,
      workflow: { input, output: input },
      taskDefinitions: new Map([
        [
          "shutdown-admission.task",
          {
            id: "shutdown-admission.task",
            input,
            output: input,
            execute: async ({ input: value }) => {
              externalStarts += 1;
              return value;
            },
          },
        ],
      ]),
    });
    const store = await openOperationalStore("file::memory:");
    close = () => store.close();
    let enteredCreateRun!: () => void;
    let release!: () => void;
    const createRunEntered = new Promise<void>((resolve) => {
      enteredCreateRun = resolve;
    });
    const createRunBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldStore: OperationalStore = {
      ...store,
      createRun: async (value) => {
        enteredCreateRun();
        await createRunBlocked;
        await store.createRun(value);
      },
    };
    const manager = createOperationalRunManager({
      workflows: [workflow],
      store: heldStore,
    });
    shutdown = () => manager.shutdown();
    const starting = manager.start("shutdown-admission", {
      version: 1,
      runId: "shutdown-admission-1",
      input: "value",
    });
    await createRunEntered;
    let shutdownSettled = false;
    const stopping = manager.shutdown().then(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);
    release();
    await starting;
    await stopping;

    expect(externalStarts).toBe(0);
    expect(await store.status("shutdown-admission-1")).toMatchObject({
      status: "cancelled",
    });
  });

  it("cancels a start held in event flush without taking an active permit", async () => {
    const input = z.string();
    const plan: Plan = {
      workflow: { id: "startup-flush-cancel" },
      nodes: [
        {
          type: "task",
          taskId: "startup-flush-cancel.task",
          nodeId: "startup-flush-cancel.task:1",
          workspace: "exclusive",
          input: { type: "ref", nodeId: "__seqlane_input", path: [] },
          dependsOn: [],
        },
      ],
      output: { type: "ref", nodeId: "startup-flush-cancel.task:1", path: [] },
    };
    let active = 0;
    let peakActive = 0;
    let externalStarts = 0;
    const workflow = createOperationalWorkflow({
      key: "startup-flush-cancel",
      plan,
      workflow: { input, output: input },
      taskDefinitions: new Map<string, TaskDefinition<string, string>>([
        [
          "startup-flush-cancel.task",
          {
            id: "startup-flush-cancel.task",
            input,
            output: input,
            execute: async ({ input: value, signal }) => {
              externalStarts += 1;
              active += 1;
              peakActive = Math.max(peakActive, active);
              if (!signal.aborted) {
                await new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  }),
                );
              }
              active -= 1;
              return value;
            },
          },
        ],
      ]),
    });
    const store = await openOperationalStore("file::memory:");
    close = () => store.close();
    let startupPlanBlocked!: () => void;
    let releaseStartupPlan!: () => void;
    const planBlocked = new Promise<void>((resolve) => {
      startupPlanBlocked = resolve;
    });
    const planGate = new Promise<void>((resolve) => {
      releaseStartupPlan = resolve;
    });
    const targetRunId = "startup-flush-cancel-target";
    const heldStore: OperationalStore = {
      ...store,
      appendEvent: async (runId, value) => {
        const event = seqlaneExecutionEventSchema.parse(value);
        if (runId === targetRunId && event.type === "run.plan") {
          startupPlanBlocked();
          await planGate;
        }
        await store.appendEvent(runId, event);
      },
    };
    const manager = createOperationalRunManager({
      workflows: [workflow],
      store: heldStore,
    });
    shutdown = () => manager.shutdown();
    const activeReferences = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        manager.start("startup-flush-cancel", {
          version: 1,
          runId: `startup-flush-cancel-${index}`,
          input: "active",
        }),
      ),
    );
    await expect.poll(() => externalStarts).toBe(4);

    let startingSettled = false;
    const starting = manager
      .start("startup-flush-cancel", {
        version: 1,
        runId: targetRunId,
        input: "queued",
      })
      .then((reference) => {
        startingSettled = true;
        return reference;
      });
    await planBlocked;
    let cancellationSettled = false;
    const cancellation = manager.cancel(targetRunId).then((result) => {
      cancellationSettled = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(startingSettled).toBe(false);
    expect(cancellationSettled).toBe(false);
    expect(active).toBe(4);

    releaseStartupPlan();
    await starting;
    expect(await cancellation).toMatchObject({
      status: "cancelled",
      cancellationRequested: true,
    });
    expect(externalStarts).toBe(4);
    expect(peakActive).toBeLessThanOrEqual(4);
    for (const reference of activeReferences)
      await manager.cancel(reference.runId);
  });

  it("bounds admission at four active and sixteen queued and drains cancellation", async () => {
    const authored = createFlow({
      id: "hosted-capacity",
      input: z.unknown(),
      output: z.unknown(),
    })
      .output(({ input }: { readonly input: unknown }) => input)
      .define();
    const built = buildWorkflow(authored);
    const workflow = createOperationalWorkflow({
      key: "capacity",
      plan: built.plan,
      workflow: authored,
    });
    const store = await openOperationalStore("file::memory:");
    close = () => store.close();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    const heldStore: OperationalStore = {
      ...store,
      setRunning: async (runId, updatedAt) => {
        active += 1;
        await blocked;
        await store.setRunning(runId, updatedAt);
      },
    };
    const manager = createOperationalRunManager({
      workflows: [workflow],
      store: heldStore,
    });
    shutdown = () => manager.shutdown();

    const starts = Array.from({ length: 20 }, (_, index) =>
      manager.start("capacity", {
        version: 1,
        runId: `capacity-${index}`,
        input: null,
      }),
    );
    const references = await Promise.all(starts);
    await expect.poll(() => active).toBe(4);
    await expect(
      manager.start("capacity", {
        version: 1,
        runId: "capacity-overflow",
        input: null,
      }),
    ).rejects.toBeInstanceOf(OperationalAdmissionError);

    const queuedCancellations = references
      .slice(4)
      .map(({ runId }) => manager.cancel(runId));

    let cancelSettled = false;
    const activeCancellation = manager
      .cancel(references[0]!.runId)
      .then((result) => {
        cancelSettled = true;
        return result;
      });
    expect(cancelSettled).toBe(false);
    release();
    expect(await activeCancellation).toMatchObject({
      status: "cancelled",
      cancellationRequested: true,
    });
    expect(
      (await Promise.all(queuedCancellations)).every(
        (result) => result.status === "cancelled",
      ),
    ).toBe(true);
    expect(active).toBe(4);
    await manager.shutdown();
  });
});
