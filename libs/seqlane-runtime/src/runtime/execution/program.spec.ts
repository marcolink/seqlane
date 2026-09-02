import { describe, expect, it, vi } from "vitest";
import {
  createSequentialProgram,
  executeSequentialProgram,
} from "./program.js";

describe("private Effect sequential runner", () => {
  it("runs steps once in order with Effect interruption signals", async () => {
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
