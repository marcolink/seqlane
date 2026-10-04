// @test-scope ./run-operational-host.ts

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionRenderer, OutputCapabilities } from "@seqlane/tui";
import type { RunRequest } from "@seqlane/protocol";
import type { OperationalClient } from "./operational-client.js";
import type { OwnedOperationalHostOptions } from "./operational-command-host.js";

const mocks = vi.hoisted(() => ({
  client: {
    startRun: vi.fn(),
  },
  startOwnedOperationalHost: vi.fn(),
}));

vi.mock("./operational-client.js", () => ({
  OperationalClient: class {
    constructor() {
      return mocks.client;
    }
  },
  OperationalClientError: class extends Error {
    readonly status: number | undefined;

    constructor(message: string, options: { status?: number } = {}) {
      super(message);
      this.status = options.status;
    }
  },
}));

vi.mock("./operational-command-host.js", () => ({
  startOwnedOperationalHost: mocks.startOwnedOperationalHost,
}));

import { executeOperationalHostRun } from "./run-operational-host.js";

const request: RunRequest = {
  type: "run.start",
  workflow: {
    id: "repository:remote",
    moduleSpecifier: "@seqlane/fixtures/remote-workflow",
    exportName: "remoteWorkflow",
  },
  input: { value: 1 },
  runtime: { id: "local" },
};

const capabilities = {
  stderr: { write: vi.fn() },
} as unknown as OutputCapabilities;

function dispatcher() {
  return {
    consume: vi.fn(),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function renderer(): ExecutionRenderer {
  return {
    mode: "ci",
    handle: vi.fn(),
    finish: vi.fn(async () => undefined),
  };
}

describe("executeOperationalHostRun", () => {
  beforeEach(() => {
    mocks.client.startRun.mockReset();
    mocks.startOwnedOperationalHost.mockReset();
  });

  it.each(["human", "ci"] as const)(
    "keeps session diagnostics out of the human tree (%s mode)",
    async (mode) => {
      const browserUrl = "http://127.0.0.1:4096/session/test-session";
      const stderr = { write: vi.fn() };
      mocks.startOwnedOperationalHost.mockImplementation(async (options) => {
        options.onSessionUiAvailable({
          invocationId: "task-1",
          browserUrl,
        });
        // Stop after exercising the real callback; no operational server needed.
        throw new Error("stop after notification");
      });

      await executeOperationalHostRun({
        request,
        sourceWorkflowReference: "repository:remote",
        roots: { repository: "/repo", user: "/user" },
        hostname: "127.0.0.1",
        port: 0,
        storageUrl: "file::memory:",
        agentRuntime: undefined,
        jsonMode: false,
        capabilities: { ...capabilities, stderr },
        dispatcher: dispatcher(),
        renderer: { ...renderer(), mode },
      });

      if (mode === "human") {
        expect(stderr.write).not.toHaveBeenCalled();
      } else {
        expect(stderr.write).toHaveBeenCalledWith(
          `Seqlane session UI: ${browserUrl}\n`,
        );
      }
    },
  );

  it("preserves a canonical serialized remote error in the run result", async () => {
    const remoteError = {
      category: "ValidationError" as const,
      message: "remote output is invalid",
      taskId: "remote.task",
      validation: {
        validationNodeId: "check-output",
        sourceId: "remote.task",
        issues: [
          {
            code: "invalid_type",
            path: "answer",
            message: "Expected string",
          },
        ],
        evidence: { state: "present" as const, value: { answer: 42 } },
      },
    };
    mocks.client.startRun.mockResolvedValue({
      status: "failed",
      error: remoteError,
    });
    const events = dispatcher();
    const rendererInstance = renderer();

    const result = await executeOperationalHostRun({
      request,
      sourceWorkflowReference: "repository:remote",
      roots: { repository: "/repo", user: "/user" },
      serverUrl: "http://127.0.0.1:4111",
      hostname: "127.0.0.1",
      port: 0,
      storageUrl: "file::memory:",
      agentRuntime: undefined,
      jsonMode: true,
      capabilities,
      dispatcher: events,
      renderer: rendererInstance,
    });

    expect(result.exitStatus).toBe(1);
    expect(result.commandResult).toMatchObject({
      status: "failed",
      phase: "execution",
      error: remoteError,
    });
    expect(events.flush).toHaveBeenCalledOnce();
    expect(events.close).toHaveBeenCalledOnce();
    expect(rendererInstance.finish).toHaveBeenCalledOnce();
  });

  it("owns presentation cleanup exactly once", async () => {
    mocks.client.startRun.mockResolvedValue({
      status: "success",
      result: { value: 1 },
    });
    const events = dispatcher();
    const rendererInstance = renderer();

    await executeOperationalHostRun({
      request,
      sourceWorkflowReference: "repository:remote",
      roots: { repository: "/repo", user: "/user" },
      serverUrl: "http://127.0.0.1:4111",
      hostname: "127.0.0.1",
      port: 0,
      storageUrl: "file::memory:",
      agentRuntime: undefined,
      jsonMode: true,
      capabilities,
      dispatcher: events,
      renderer: rendererInstance,
    });

    expect(events.flush).toHaveBeenCalledOnce();
    expect(events.close).toHaveBeenCalledOnce();
    expect(rendererInstance.finish).toHaveBeenCalledOnce();
  });

  it("closes every resource when owned-host setup fails", async () => {
    const setupError = new Error("host setup failed");
    mocks.startOwnedOperationalHost.mockRejectedValue(setupError);
    const events = dispatcher();
    const rendererInstance = renderer();

    const result = await executeOperationalHostRun({
      request,
      sourceWorkflowReference: "repository:remote",
      roots: { repository: "/repo", user: "/user" },
      hostname: "127.0.0.1",
      port: 0,
      storageUrl: "file::memory:",
      agentRuntime: undefined,
      jsonMode: true,
      capabilities,
      dispatcher: events,
      renderer: rendererInstance,
    });

    expect(result.commandResult).toMatchObject({
      status: "failed",
      phase: "execution",
      error: { message: setupError.message },
    });
    expect(events.flush).toHaveBeenCalledOnce();
    expect(events.close).toHaveBeenCalledOnce();
    expect(rendererInstance.finish).toHaveBeenCalledOnce();
  });

  it("closes every resource for runtime cancellation", async () => {
    mocks.client.startRun.mockResolvedValue({ status: "cancelled" });
    const events = dispatcher();
    const rendererInstance = renderer();

    const result = await executeOperationalHostRun({
      request,
      sourceWorkflowReference: "repository:remote",
      roots: { repository: "/repo", user: "/user" },
      serverUrl: "http://127.0.0.1:4111",
      hostname: "127.0.0.1",
      port: 0,
      storageUrl: "file::memory:",
      agentRuntime: undefined,
      jsonMode: true,
      capabilities,
      dispatcher: events,
      renderer: rendererInstance,
    });

    expect(result.exitStatus).toBe(130);
    expect(result.commandResult.status).toBe("cancelled");
    expect(events.flush).toHaveBeenCalledOnce();
    expect(events.close).toHaveBeenCalledOnce();
    expect(rendererInstance.finish).toHaveBeenCalledOnce();
  });

  it("drains accepted events and reports failure when an owned-host event exceeds the queue budget", async () => {
    const closeHost = vi.fn(async () => undefined);
    mocks.startOwnedOperationalHost.mockImplementation(
      async (options: OwnedOperationalHostOptions) => {
        const eventSink = options.eventSink;
        if (eventSink === undefined) throw new Error("Expected an event sink");
        mocks.client.startRun.mockImplementation(
          async (run: Parameters<OperationalClient["startRun"]>[0]) => {
            eventSink(run).emit({
              type: "invocation.output",
              workId: run.workId,
              runId: run.runId,
              invocationId: "task-1",
              policy: "persistent",
              channel: "task",
              content: "x".repeat(16 * 1024 * 1024),
            });
            return { status: "success", result: null };
          },
        );
        return { address: "http://127.0.0.1:4111", close: closeHost };
      },
    );
    const events = dispatcher();
    const rendererInstance = renderer();

    const result = await executeOperationalHostRun({
      request,
      roots: { repository: "/repo", user: "/user" },
      hostname: "127.0.0.1",
      port: 0,
      storageUrl: "file::memory:",
      jsonMode: true,
      capabilities,
      dispatcher: events,
      renderer: rendererInstance,
    });

    expect(result.exitStatus).toBe(1);
    expect(result.commandResult).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("Execution event queue exceeded"),
      },
    });
    expect(events.consume).toHaveBeenCalledTimes(2);
    expect(events.consume).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "run.started",
        metadata: expect.objectContaining({ sequence: 1 }),
      }),
    );
    expect(events.consume).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "run.failed",
        metadata: expect.objectContaining({ sequence: 2 }),
      }),
    );
    expect(closeHost).toHaveBeenCalledOnce();
    expect(events.close).toHaveBeenCalledOnce();
    expect(rendererInstance.finish).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "returns failure and completes cleanup after event delivery fails (permanent=%s)",
    async (permanent) => {
      mocks.client.startRun.mockResolvedValue({
        status: "success",
        result: null,
      });
      const closeHost = vi.fn(async () => undefined);
      mocks.startOwnedOperationalHost.mockResolvedValue({
        address: "http://127.0.0.1:4111",
        close: closeHost,
      });
      const events = dispatcher();
      const deliveryError = new Error("event delivery failed");
      if (permanent) {
        events.consume.mockImplementation(() => {
          throw deliveryError;
        });
      } else {
        events.consume.mockImplementationOnce(() => {
          throw deliveryError;
        });
      }
      const rendererInstance = renderer();

      const result = await executeOperationalHostRun({
        request,
        roots: { repository: "/repo", user: "/user" },
        hostname: "127.0.0.1",
        port: 0,
        storageUrl: "file::memory:",
        jsonMode: true,
        capabilities,
        dispatcher: events,
        renderer: rendererInstance,
      });

      expect(result.exitStatus).toBe(1);
      expect(result.commandResult).toMatchObject({
        status: "failed",
        error: { message: deliveryError.message },
      });
      expect(events.consume).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "run.failed",
          metadata: expect.objectContaining({ sequence: 1 }),
        }),
      );
      expect(closeHost).toHaveBeenCalledOnce();
      expect(events.flush).toHaveBeenCalledOnce();
      expect(events.close).toHaveBeenCalledOnce();
      expect(rendererInstance.finish).toHaveBeenCalledOnce();
      if (permanent) expect(result.cleanupErrors).toContain(deliveryError);
    },
  );
});
