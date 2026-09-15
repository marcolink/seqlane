// @test-scope ./run-operational-host.ts

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputCapabilities } from "@seqlane/output";
import type { RunRequest } from "@seqlane/protocol";

const mocks = vi.hoisted(() => ({
  client: {
    startRun: vi.fn(),
  },
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

describe("executeOperationalHostRun", () => {
  beforeEach(() => {
    mocks.client.startRun.mockReset();
  });

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
      disconnectResize: vi.fn(),
    });

    expect(result.exitStatus).toBe(1);
    expect(result.commandResult).toMatchObject({
      status: "failed",
      phase: "execution",
      error: remoteError,
    });
  });

  it("can leave presentation resources to the outer command lifecycle", async () => {
    mocks.client.startRun.mockResolvedValue({
      status: "success",
      result: { value: 1 },
    });
    const events = dispatcher();

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
      disconnectResize: vi.fn(),
      managePresentationResources: false,
    });

    expect(events.flush).not.toHaveBeenCalled();
    expect(events.close).not.toHaveBeenCalled();
  });
});
