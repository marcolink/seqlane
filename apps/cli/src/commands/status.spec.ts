// @test-scope ./status.ts
// @test-scope ../workflow-reference.ts

import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StatusCommand from "./status.js";

const mocks = vi.hoisted(() => ({
  client: {
    getRun: vi.fn(),
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

describe("status command workflow selection", () => {
  beforeEach(() => {
    mocks.client.getRun.mockReset();
    mocks.client.getRun.mockResolvedValue({
      runId: "run-1",
      status: "success",
    });
    mocks.startOwnedOperationalHost.mockReset();
    mocks.startOwnedOperationalHost.mockResolvedValue({
      address: "http://127.0.0.1:4111",
      close: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("passes a direct workflow reference to an owned host", async () => {
    await StatusCommand.run(
      ["run-1", "--workflow", "./examples/minimal-workflow.ts"],
      { root: cliRoot },
    );

    expect(mocks.startOwnedOperationalHost).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: {
          id: "./examples/minimal-workflow.ts",
          exportName: "default",
          moduleSpecifier: expect.stringMatching(
            /^file:\/\/.*\/examples\/minimal-workflow\.ts$/,
          ),
        },
      }),
    );
    expect(mocks.client.getRun).toHaveBeenCalledWith(
      "run-1",
      "./examples/minimal-workflow.ts",
    );
  });

  it("does not load a direct workflow reference for a remote host", async () => {
    await StatusCommand.run(
      [
        "run-1",
        "--workflow",
        "./examples/minimal-workflow.ts",
        "--server-url",
        "http://127.0.0.1:4111",
      ],
      { root: cliRoot },
    );

    expect(mocks.startOwnedOperationalHost).not.toHaveBeenCalled();
    expect(mocks.client.getRun).toHaveBeenCalledWith(
      "run-1",
      "./examples/minimal-workflow.ts",
    );
  });
});
