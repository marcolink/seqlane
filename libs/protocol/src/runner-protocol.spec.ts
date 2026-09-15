import { describe, expect, it } from "vitest";
import {
  decodeRunnerCommand,
  encodeRunnerCommand,
  isCancelRun,
  isRunnerCommand,
  isRunRequest,
} from "./runner-protocol.js";
import type { RunnerCommand } from "./runner-protocol.js";

describe("Seqlane runner command protocol", () => {
  it("accepts and round-trips a run.start command", () => {
    const command: RunnerCommand = {
      type: "run.start",
      workflow: {
        id: "fix-renovate-update",
        moduleSpecifier: "./workflows/fix-renovate-update.js",
        exportName: "default",
      },
      input: {
        dependency: "some-package",
        versions: ["1.0.0", "2.0.0"],
      },
      runtime: { id: "local-agent", workspace: "/checkout" },
    };

    expect(isRunRequest(command)).toBe(true);
    expect(isRunnerCommand(command)).toBe(true);
    expect(decodeRunnerCommand(encodeRunnerCommand(command))).toEqual(command);
  });

  it("rejects a legacy runtime session policy", () => {
    const command: unknown = {
      type: "run.start",
      workflow: {
        id: "workflow-1",
        moduleSpecifier: "./workflow.js",
        exportName: "workflow",
      },
      input: null,
      runtime: { id: "local-agent", sessionPolicy: "isolated" },
    };

    expect(isRunRequest(command)).toBe(false);
  });

  it("accepts a dry-run request", () => {
    const command: RunnerCommand = {
      type: "run.start",
      workflow: {
        id: "workflow-1",
        moduleSpecifier: "./workflow.js",
        exportName: "workflow",
      },
      input: null,
      runtime: { id: "local-agent" },
      dryRun: true,
    };

    expect(decodeRunnerCommand(encodeRunnerCommand(command))).toEqual(command);
  });

  it("accepts and round-trips run.cancel", () => {
    const command: RunnerCommand = { type: "run.cancel" };

    expect(isCancelRun(command)).toBe(true);
    expect(isRunnerCommand(command)).toBe(true);
    expect(decodeRunnerCommand(encodeRunnerCommand(command))).toEqual(command);
  });

  it("rejects event-shaped messages", () => {
    expect(isRunnerCommand({ type: "run.started" })).toBe(false);
    expect(() => decodeRunnerCommand('{"type":"run.started"}')).toThrow(
      "Invalid runner command",
    );
  });

  it("rejects an empty runtime workspace", () => {
    expect(
      isRunRequest({
        type: "run.start",
        workflow: {
          id: "workflow-1",
          moduleSpecifier: "./workflow.js",
          exportName: "workflow",
        },
        input: null,
        runtime: { id: "local-agent", workspace: "" },
      }),
    ).toBe(false);
  });

  it("rejects all runtime session policies", () => {
    const command: unknown = {
      type: "run.start",
      workflow: {
        id: "workflow-1",
        moduleSpecifier: "./workflow.js",
        exportName: "workflow",
      },
      input: null,
      runtime: { id: "local-agent", sessionPolicy: "isolated" },
    };

    expect(isRunRequest(command)).toBe(false);
  });

  it("rejects a non-boolean dry-run value", () => {
    expect(
      isRunRequest({
        type: "run.start",
        workflow: {
          id: "workflow-1",
          moduleSpecifier: "./workflow.js",
          exportName: "workflow",
        },
        input: null,
        runtime: { id: "local-agent" },
        dryRun: "true",
      }),
    ).toBe(false);
  });

  it("rejects malformed commands", () => {
    expect(() => decodeRunnerCommand("not-json")).toThrow(
      "Invalid runner command",
    );
    expect(() =>
      encodeRunnerCommand({ type: "run.cancel", extra: true } as never),
    ).toThrow("Invalid runner command");

    const cyclic = { type: "run.cancel" } as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(() => encodeRunnerCommand(cyclic as never)).toThrow(
      "Invalid runner command",
    );
  });

  it("rejects commands with malformed nested protocol values", () => {
    const command = {
      type: "run.start",
      workflow: {
        id: "workflow-1",
        moduleSpecifier: "./workflow.js",
        exportName: "default",
        extra: true,
      },
      input: { value: Number.NaN },
      runtime: { id: "local" },
    };

    expect(isRunRequest(command)).toBe(false);
    expect(isRunnerCommand(command)).toBe(false);
  });

  it("rejects sparse JSON input arrays", () => {
    const input: unknown[] = [];
    input.length = 2;
    input[1] = "value";

    const command = {
      type: "run.start",
      workflow: {
        id: "workflow-1",
        moduleSpecifier: "./workflow.js",
        exportName: "default",
      },
      input,
      runtime: { id: "local" },
    };

    expect(isRunRequest(command)).toBe(false);
    expect(isRunnerCommand(command)).toBe(false);
    expect(() => encodeRunnerCommand(command as never)).toThrow(
      "Invalid runner command",
    );
  });
});
