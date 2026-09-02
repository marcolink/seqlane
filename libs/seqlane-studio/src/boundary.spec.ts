// @test-scope ./protocol.ts
// @test-scope ./registry.ts

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  StudioInvocationSnapshot,
  StudioRunSnapshot,
} from "./protocol.js";
import { StudioRegistry } from "./registry.js";

const forbiddenBoundaryNames = [
  "executor",
  "mastra",
  "opencode",
  "prompt",
  "toolCall",
  "modelConfiguration",
] as const;

describe("Studio package boundary", () => {
  it("depends on core and events and keeps forbidden fields out of snapshots", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(packageJson.dependencies).toEqual({
      "@seqlane/core": "workspace:*",
      "@seqlane/events": "workspace:*",
    });

    const invocation: StudioInvocationSnapshot = {
      invocationId: "invocation-1",
      planNodeId: "node-1",
      taskId: "task-1",
      kind: "task",
      label: "Task",
      siblingOrder: 0,
      dependencyIds: [],
      state: "succeeded",
      output: { persistent: [] },
    };
    const snapshot: StudioRunSnapshot = {
      summary: {
        workId: "work-1",
        runId: "run-1",
        workflowId: "workflow-1",
        state: "succeeded",
        isIncomplete: false,
        activeInvocationCount: 0,
        lastEventSequence: 1,
      },
      cursor: 1,
      invocations: [invocation],
    };
    const serialized = JSON.stringify(snapshot).toLowerCase();
    for (const name of forbiddenBoundaryNames) {
      expect(serialized).not.toContain(name.toLowerCase());
    }
  });

  it("keeps executor and Mastra names out of the public protocol source", () => {
    const protocol = readFileSync(
      new URL("./protocol.ts", import.meta.url),
      "utf8",
    );
    for (const name of forbiddenBoundaryNames) {
      expect(protocol.toLowerCase()).not.toContain(name.toLowerCase());
    }
  });

  it("rejects executor-specific fields at the Studio ingest boundary", () => {
    const registry = new StudioRegistry();
    expect(() =>
      registry.ingest({
        workflowId: "workflow-1",
        event: {
          type: "run.started",
          workId: "work-1",
          runId: "run-1",
          metadata: {
            schemaVersion: 1,
            eventId: "event-1",
            sequence: 1,
            occurredAt: "2026-08-18T00:00:00.000Z",
          },
          executor: "opencode",
        } as never,
      }),
    ).toThrow("Invalid Seqlane execution event");
  });
});
