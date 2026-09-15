// @test-scope ./mastra-repeat-envelope.ts

import { describe, expect, it } from "vitest";
import {
  assertRepeatEnvelopeSize,
  MAX_REPEAT_ENVELOPE_BYTES,
  repeatEnvelopeSchema,
  repeatWorkflowStateSchema,
} from "./mastra-repeat-envelope.js";

describe("Mastra repeat persistence envelope", () => {
  it("round-trips the control envelope as JSON without dependency payloads", () => {
    const envelope = {
      __seqlaneRepeatEnvelope: true,
      stateRef: { workflowId: "repeat:1:loop", runId: "run:repeat:1" },
      attemptNumber: 4,
      until: false,
      runContext: {
        workId: "work",
        runId: "run",
        resourceId: "resource",
      },
      repeatExecutions: 3,
    } as const;

    const reloaded = repeatEnvelopeSchema.parse(
      JSON.parse(JSON.stringify(envelope)),
    );

    expect(reloaded).toEqual(envelope);
    expect(reloaded).not.toHaveProperty("dependencyResults");
    expect(reloaded).not.toHaveProperty("currentInput");
    expect(reloaded).not.toHaveProperty("result");
  });

  it("rejects an oversized control envelope before persistence", () => {
    const envelope = repeatEnvelopeSchema.parse({
      __seqlaneRepeatEnvelope: true,
      stateRef: { workflowId: "repeat:1:loop", runId: "run:repeat:1" },
      attemptNumber: 1,
      runContext: {
        workId: "😀".repeat(MAX_REPEAT_ENVELOPE_BYTES),
        runId: "run",
      },
      repeatExecutions: 0,
    });

    expect(() => assertRepeatEnvelopeSize(envelope)).toThrow(
      /exceeds 16384 bytes/,
    );
  });

  it("round-trips durable repeat state separately from the envelope", () => {
    const state = {
      initialInput: { value: 1 },
      currentInput: { value: 2 },
      workflowInput: { seed: "fixture" },
      dependencyResults: [["upstream", { ready: true }]] as Array<
        [string, unknown]
      >,
      result: { done: false },
    };

    expect(
      repeatWorkflowStateSchema.parse(JSON.parse(JSON.stringify(state))),
    ).toEqual(state);
  });
});
