// @test-scope ./cancel.ts
// @test-scope ../workflow-reference.ts

import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CancelCommand from "./cancel.js";

const mocks = vi.hoisted(() => ({
  client: {
    cancelRun: vi.fn(),
  },
  startOwnedOperationalHost: vi.fn(),
}));

vi.mock("../operational-client.js", () => ({
  OperationalClient: class {
    constructor() {
      return mocks.client;
    }
  },
}));
vi.mock("../operational-command-host.js", () => ({
  startOwnedOperationalHost: mocks.startOwnedOperationalHost,
}));

const cliRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("cancel command workflow selection", () => {
  beforeEach(() => {
    mocks.client.cancelRun.mockReset();
    mocks.client.cancelRun.mockResolvedValue("Workflow run cancelled");
    mocks.startOwnedOperationalHost.mockReset();
    mocks.startOwnedOperationalHost.mockResolvedValue({
      address: "http://127.0.0.1:4111",
      close: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("passes a direct workflow reference to an owned host", async () => {
    await CancelCommand.run(
      ["run-1", "--workflow", "./workflows/minimal-example/workflow.ts"],
      { root: cliRoot },
    );

    expect(mocks.startOwnedOperationalHost).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: {
          id: "./workflows/minimal-example/workflow.ts",
          exportName: "default",
          moduleSpecifier: expect.stringMatching(
            /^file:\/\/.*\/examples\/minimal-workflow\.ts$/,
          ),
        },
      }),
    );
    expect(mocks.client.cancelRun).toHaveBeenCalledWith(
      "run-1",
      "./workflows/minimal-example/workflow.ts",
    );
  });

  it("does not load a direct workflow reference for a remote host", async () => {
    await CancelCommand.run(
      [
        "run-1",
        "--workflow",
        "./workflows/minimal-example/workflow.ts",
        "--server-url",
        "http://127.0.0.1:4111",
      ],
      { root: cliRoot },
    );

    expect(mocks.startOwnedOperationalHost).not.toHaveBeenCalled();
    expect(mocks.client.cancelRun).toHaveBeenCalledWith(
      "run-1",
      "./workflows/minimal-example/workflow.ts",
    );
  });
});
