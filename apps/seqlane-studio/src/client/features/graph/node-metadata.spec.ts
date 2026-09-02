import type { StudioInvocationSnapshot } from "@seqlane/studio/protocol";
import { describe, expect, it } from "vitest";
import { formatInvocationNodeLabel } from "./node-metadata.js";

function invocation(
  overrides: Partial<StudioInvocationSnapshot> = {},
): StudioInvocationSnapshot {
  return {
    invocationId: "invocation-1",
    planNodeId: "node-1",
    taskId: "task-1",
    kind: "task",
    label: "Prepare",
    siblingOrder: 0,
    dependencyIds: [],
    state: "succeeded",
    output: { persistent: [] },
    ...overrides,
  };
}

describe("Studio node metadata", () => {
  it("shows duration, tokens, cost, and display-value states inline", () => {
    expect(
      formatInvocationNodeLabel(
        invocation({
          input: { state: "present", value: { value: true } },
          result: { state: "present", value: { value: "done" } },
          startedAt: "2026-08-18T00:00:00.000Z",
          finishedAt: "2026-08-18T00:00:01.250Z",
          output: {
            persistent: [],
            metrics: {
              tokens: {
                total: 1240,
                input: 800,
                output: 300,
                reasoning: 140,
                cacheRead: 0,
                cacheWrite: 0,
              },
              cost: 0.0042,
            },
          },
        }),
      ),
    ).toBe(
      "Prepare\nsucceeded\n1.25 s · 1.2k tok · $0.0042 · in present · out present",
    );
  });

  it("uses executor duration when available and avoids empty metadata lines", () => {
    expect(
      formatInvocationNodeLabel(
        invocation({
          output: {
            persistent: [],
            metrics: { durationMs: 42 },
          },
        }),
      ),
    ).toBe("Prepare\nsucceeded\n42 ms");
  });

  it("shows validation verdict and bounded evidence state inline", () => {
    expect(
      formatInvocationNodeLabel(
        invocation({
          kind: "validation",
          label: "Validate release",
          validation: {
            validationNodeId: "validation.gate:1",
            sourceId: "release-ready",
            sourceType: "validation-gate",
            verdict: "failed",
            issues: [{ code: "unsafe", message: "Unsafe result" }],
            evidence: { state: "redacted" },
            continued: false,
          },
        }),
      ),
    ).toContain("validation release-ready · failed · evidence redacted");
  });
});
