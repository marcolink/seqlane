// @test-scope ./program.ts
// @test-scope ./run-sequential-graph.ts
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  createSequentialProgram,
  executeSequentialProgram,
  runProgram,
} from "./program.js";

describe("private sequential program runner", () => {
  it("runs steps once in order with cancellation signals", async () => {
    const executions: string[] = [];
    const signals: AbortSignal[] = [];
    const program = createSequentialProgram({
      steps: ["task:1", "task:2", "task:3"].map((id) => ({
        id,
        execute: async ({ abortSignal }) => {
          executions.push(id);
          signals.push(abortSignal);
        },
      })),
    });

    await expect(executeSequentialProgram(program)).resolves.toEqual({
      status: "success",
    });
    expect(program.steps.map((step) => step.id)).toEqual([
      "task:1",
      "task:2",
      "task:3",
    ]);
    expect(executions).toEqual(["task:1", "task:2", "task:3"]);
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it("interrupts a running step when the caller aborts", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const execute = vi.fn(
      async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        markStarted();
        await new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              markAborted();
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
      },
    );
    const program = createSequentialProgram({
      steps: [{ id: "task:1", execute }],
    });
    const outcome = executeSequentialProgram(program, controller.signal);

    await started;
    controller.abort();
    await aborted;

    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("waits for a running step to confirm cancellation before resolving", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let confirmCancellation!: () => void;
    const cancellationConfirmed = new Promise<void>((resolve) => {
      confirmCancellation = resolve;
    });
    let settled = false;
    const program = createSequentialProgram({
      steps: [
        {
          id: "task:1",
          execute: async ({ abortSignal }) => {
            markStarted();
            await new Promise<void>((resolve) => {
              abortSignal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            await cancellationConfirmed;
            throw new Error("cancelled after confirmation");
          },
        },
      ],
    });
    const outcome = executeSequentialProgram(program, controller.signal).then(
      (result) => {
        settled = true;
        return result;
      },
    );

    await started;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);

    confirmCancellation();
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
  });

  it("does not start a program when its signal is already aborted", async () => {
    const controller = new AbortController();
    const execute = vi.fn();
    const program = createSequentialProgram({
      steps: [{ id: "task:1", execute }],
    });
    controller.abort();

    await expect(
      executeSequentialProgram(program, controller.signal),
    ).resolves.toEqual({ status: "cancelled" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the original step rejection", async () => {
    const error = new Error("step failed");
    const program = createSequentialProgram({
      steps: [
        {
          id: "task:1",
          execute: async () => Promise.reject(error),
        },
      ],
    });

    await expect(executeSequentialProgram(program)).resolves.toEqual({
      status: "failed",
      error,
    });
  });

  it("rejects dependency cycles before starting any step", () => {
    const execute = vi.fn();
    expect(() =>
      createSequentialProgram({
        steps: [
          { id: "a", dependsOn: ["b"], execute },
          { id: "b", dependsOn: ["a"], execute },
        ],
      }),
    ).toThrow(/dependency cycle/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an invalid private concurrency bound through its Zod contract", () => {
    expect(() =>
      createSequentialProgram({ concurrency: 0.5, steps: [] }),
    ).toThrow();
  });

  it("starts a fast successor while an unrelated prerequisite is still running", async () => {
    let finishSlow!: () => void;
    const slowFinished = new Promise<void>((resolve) => {
      finishSlow = resolve;
    });
    let startSuccessor!: () => void;
    const successorStarted = new Promise<void>((resolve) => {
      startSuccessor = resolve;
    });
    const program = createSequentialProgram({
      steps: [
        {
          id: "slow",
          dependsOn: [],
          execute: () => slowFinished,
        },
        {
          id: "fast",
          dependsOn: [],
          execute: async () => undefined,
        },
        {
          id: "successor",
          dependsOn: ["fast"],
          execute: async () => {
            startSuccessor();
          },
        },
      ],
    });
    const outcome = executeSequentialProgram(program);

    await successorStarted;
    finishSlow();
    await expect(outcome).resolves.toEqual({ status: "success" });
  });

  it("does not let a dependency waiter consume the only body permit", async () => {
    const executionOrder: string[] = [];
    const program = createSequentialProgram({
      concurrency: 1,
      steps: [
        {
          id: "waiter",
          dependsOn: ["root"],
          execute: async () => {
            executionOrder.push("waiter");
          },
        },
        {
          id: "root",
          dependsOn: [],
          execute: async () => {
            executionOrder.push("root");
          },
        },
      ],
    });

    await expect(executeSequentialProgram(program)).resolves.toEqual({
      status: "success",
    });
    expect(executionOrder).toEqual(["root", "waiter"]);
  });

  it("does not run dependents after failure and keeps the original cause", async () => {
    const error = new Error("prerequisite failed");
    const dependent = vi.fn();
    const skipped = vi.fn();
    const program = createSequentialProgram({
      steps: [
        { id: "root", execute: async () => Promise.reject(error) },
        {
          id: "dependent",
          dependsOn: ["root"],
          execute: dependent,
          onSkip: skipped,
        },
      ],
    });

    await expect(executeSequentialProgram(program)).resolves.toEqual({
      status: "failed",
      error,
    });
    expect(dependent).not.toHaveBeenCalled();
    expect(skipped).toHaveBeenCalledWith(["root"]);
  });

  it("settles downstream steps when an onSkip callback throws", async () => {
    const prerequisiteError = new Error("prerequisite failed");
    const callbackError = new Error("skip callback failed");
    const middleBody = vi.fn();
    const leafBody = vi.fn();
    const leafSkip = vi.fn();
    const program = createSequentialProgram({
      steps: [
        {
          id: "root",
          execute: async () => Promise.reject(prerequisiteError),
        },
        {
          id: "middle",
          dependsOn: ["root"],
          execute: middleBody,
          onSkip: () => {
            throw callbackError;
          },
        },
        {
          id: "leaf",
          dependsOn: ["middle"],
          execute: leafBody,
          onSkip: leafSkip,
        },
      ],
    });

    const results = await Effect.runPromise(
      runProgram(program, new AbortController().signal),
    );
    await expect(executeSequentialProgram(program)).resolves.toEqual({
      status: "failed",
      error: prerequisiteError,
    });
    expect(results).toEqual([
      { status: "failed", error: prerequisiteError },
      { status: "failed", error: callbackError },
      { status: "failed", error: callbackError },
    ]);
    expect(middleBody).not.toHaveBeenCalled();
    expect(leafBody).not.toHaveBeenCalled();
    expect(leafSkip).toHaveBeenCalledWith(["middle"]);
  });

  it("cancels a permit waiter before its body starts", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseActive!: () => void;
    const activeBarrier = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const queuedBody = vi.fn();
    const queuedOnCancel = vi.fn();
    const program = createSequentialProgram({
      concurrency: 1,
      steps: [
        {
          id: "active",
          dependsOn: [],
          execute: async () => {
            markStarted();
            await activeBarrier;
          },
        },
        {
          id: "queued",
          dependsOn: [],
          execute: queuedBody,
          onCancel: queuedOnCancel,
        },
      ],
    });
    const outcome = executeSequentialProgram(program, controller.signal);

    await started;
    controller.abort();
    releaseActive();

    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(queuedOnCancel).toHaveBeenCalledOnce();
    expect(queuedBody).not.toHaveBeenCalled();
  });

  it("treats an abort racing a step rejection as cancellation", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let reject!: (error: Error) => void;
    const stepError = new Error("step failed");
    const program = createSequentialProgram({
      steps: [
        {
          id: "task:1",
          execute: async () => {
            markStarted();
            return new Promise<never>((_resolve, rejectStep) => {
              reject = rejectStep;
            });
          },
        },
      ],
    });
    const outcome = executeSequentialProgram(program, controller.signal);

    await started;
    reject(stepError);
    controller.abort();

    await expect(outcome).resolves.toEqual({ status: "cancelled" });
  });

  it("treats an abort after step completion but before program exit as cancellation", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let completeStep!: () => void;
    const program = createSequentialProgram({
      steps: [
        {
          id: "task:1",
          execute: async () => {
            markStarted();
            await new Promise<void>((resolve) => {
              completeStep = resolve;
            });
          },
        },
      ],
    });
    const outcome = executeSequentialProgram(program, controller.signal);

    await started;
    completeStep();
    controller.abort();

    await expect(outcome).resolves.toEqual({ status: "cancelled" });
  });
});
