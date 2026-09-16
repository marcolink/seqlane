// @test-scope ./run-operational-host.ts

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionRenderer, OutputCapabilities } from "@seqlane/tui";
import type { RunRequest } from "@seqlane/protocol";

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
        adapterConfiguration: undefined,
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
      adapterConfiguration: undefined,
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
      adapterConfiguration: undefined,
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
      adapterConfiguration: undefined,
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
      adapterConfiguration: undefined,
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
});
