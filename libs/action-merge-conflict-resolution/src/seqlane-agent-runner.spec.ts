// @test-scope ./seqlane-agent-runner.ts

import type { ResolveMergeConflictsWorkflowOutput } from "@seqlane/resolve-merge-conflicts-workflow";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createFlow, type SeqlaneSchema } from "@seqlane/core";

import {
  createSeqlaneAgentRunner,
  type SeqlaneWorkflowInput,
} from "./seqlane-agent-runner.js";

const schema = <T>(): SeqlaneSchema<T> => z.custom<T>(() => true);

const workflow = createFlow<
  SeqlaneWorkflowInput,
  ResolveMergeConflictsWorkflowOutput
>({
  id: "runner-stop-regression",
  input: schema<SeqlaneWorkflowInput>(),
  output: schema<ResolveMergeConflictsWorkflowOutput>(),
})
  .output({ summary: "", resolvedFiles: [], decisions: [] })
  .define();

describe("Seqlane agent runner", () => {
  it("retries runtime cleanup when the first stop rejects", async () => {
    const cleanupError = new Error("runtime cleanup failed");
    let cleanupCalls = 0;
    const runtimeStop = vi.fn(async () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) throw cleanupError;
    });
    const runner = createSeqlaneAgentRunner({
      workspace: "/tmp/agent",
      workflow,
      openCode: {
        start: async () => ({
          connection: { url: "http://127.0.0.1:4096" },
          stop: runtimeStop,
        }),
      },
    });

    if (runner.start === undefined || runner.stop === undefined) {
      throw new Error("Runner lifecycle methods are required for this test.");
    }
    await runner.start();
    await expect(runner.stop()).rejects.toBe(cleanupError);
    await expect(runner.stop()).resolves.toBeUndefined();

    expect(runtimeStop).toHaveBeenCalledTimes(2);
  });

  it("preserves an undefined cleanup failure", async () => {
    const runtimeStop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(undefined)
      .mockResolvedValue(undefined);
    const runner = createSeqlaneAgentRunner({
      workspace: "/tmp/agent",
      workflow,
      openCode: {
        start: async () => ({
          connection: { url: "http://127.0.0.1:4096" },
          stop: runtimeStop,
        }),
      },
    });

    if (runner.start === undefined || runner.stop === undefined) {
      throw new Error("Runner lifecycle methods are required for this test.");
    }
    await runner.start();
    await expect(runner.stop()).rejects.toBeUndefined();
    await expect(runner.stop()).resolves.toBeUndefined();
  });

  it("propagates runtime startup failures", async () => {
    const startupError = new Error("runtime startup failed");
    const runtimeStart = vi.fn(async () => {
      throw startupError;
    });
    const runner = createSeqlaneAgentRunner({
      workspace: "/tmp/agent",
      workflow,
      openCode: {
        start: runtimeStart,
      },
    });

    if (runner.start === undefined) {
      throw new Error("Runner start method is required for this test.");
    }
    await expect(runner.start()).rejects.toBe(startupError);
    expect(runtimeStart).toHaveBeenCalledTimes(1);
  });

  it("aborts and waits for rejected runtime acquisition before stopping", async () => {
    const acquisitionError = new Error("agent runtime acquisition failed");
    const runtimeStop = vi.fn(async () => undefined);
    let rejectAcquisition!: (error: Error) => void;
    let acquiredSignal: AbortSignal | undefined;
    let signalAcquisitionStarted!: () => void;
    const acquisitionStarted = new Promise<void>((resolve) => {
      signalAcquisitionStarted = resolve;
    });
    const runner = createSeqlaneAgentRunner({
      workspace: "/tmp/agent",
      workflow,
      openCode: {
        start: async () => ({
          connection: { url: "http://127.0.0.1:4096" },
          stop: runtimeStop,
        }),
      },
      createAgentRuntime: (_connection, _workspace, signal) => {
        acquiredSignal = signal;
        signalAcquisitionStarted();
        return new Promise((_resolve, reject) => {
          rejectAcquisition = reject;
        });
      },
    });

    const resolution = runner.resolve({
      paths: ["src/file.ts"],
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    });
    await acquisitionStarted;
    if (runner.stop === undefined) {
      throw new Error("Runner stop method is required for this test.");
    }
    const firstStop = runner.stop();
    const secondStop = runner.stop();

    await vi.waitFor(() => expect(acquiredSignal?.aborted).toBe(true));
    expect(runtimeStop).not.toHaveBeenCalled();
    rejectAcquisition(acquisitionError);

    await expect(resolution).rejects.toMatchObject({ cause: acquisitionError });
    await Promise.all([firstStop, secondStop]);
    await runner.stop();
    expect(runtimeStop).toHaveBeenCalledTimes(1);
  });

  it("rejects overlapping resolutions and accepts a new attempt after settlement", async () => {
    const acquisitionError = new Error("agent runtime acquisition failed");
    let acquisitionCount = 0;
    let rejectAcquisition!: (error: Error) => void;
    let signalAcquisitionStarted!: () => void;
    const acquisitionStarted = new Promise<void>((resolve) => {
      signalAcquisitionStarted = resolve;
    });
    const runner = createSeqlaneAgentRunner({
      workspace: "/tmp/agent",
      workflow,
      openCode: {
        start: async () => ({
          connection: { url: "http://127.0.0.1:4096" },
          stop: async () => undefined,
        }),
      },
      createAgentRuntime: () => {
        acquisitionCount += 1;
        signalAcquisitionStarted();
        return new Promise((_resolve, reject) => {
          rejectAcquisition = reject;
        });
      },
    });
    const request = {
      paths: ["src/file.ts"],
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    };

    const first = runner.resolve(request);
    await acquisitionStarted;
    await expect(runner.resolve(request)).rejects.toMatchObject({
      message: "The conflict-resolution runner is already active or stopping.",
    });
    rejectAcquisition(acquisitionError);
    await expect(first).rejects.toMatchObject({ cause: acquisitionError });

    const next = runner.resolve(request);
    await vi.waitFor(() => expect(acquisitionCount).toBe(2));
    rejectAcquisition(acquisitionError);
    await expect(next).rejects.toMatchObject({ cause: acquisitionError });
  });
});
