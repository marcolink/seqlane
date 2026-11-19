import { describe, expect, it } from "vitest";
import { createCodexModelObservation } from "./observations.js";

describe("Codex model observations", () => {
  it("preserves complete request, response, usage, zeros, and correlation", () => {
    const observation = createCodexModelObservation({
      invocationId: "invocation-1",
      state: "succeeded",
      selection: {
        model: { provider: "openai", model: "gpt-5.6-sol" },
      },
      request: {
        input: [{ type: "text", text: "" }],
        outputSchema: {
          type: "object",
          properties: { done: { type: "boolean" } },
        },
        sandboxPolicy: { networkAccess: false },
      },
      responseId: "turn-1",
      response: {
        text: '{"done":false,"count":0,"text":""}',
        output: { done: false, count: 0, text: "", items: [""] },
        items: [{ type: "agentMessage", text: '{"done":false}' }],
      },
      usage: {
        total: { inputTokens: 0, outputTokens: 2 },
        last: { inputTokens: 0, outputTokens: 2, custom: { cache: 0 } },
      },
      startedAt: 100,
      endedAt: 125,
    });

    expect(observation).toMatchObject({
      observationId: "invocation-1:model:0",
      state: "succeeded",
      attemptIndex: 0,
      model: {
        provider: "openai",
        model: "gpt-5.6-sol",
        responseId: "turn-1",
        startedAt: 100,
        endedAt: 125,
        request: {
          input: [{ text: "" }],
          sandboxPolicy: { networkAccess: false },
        },
        response: { output: { done: false, count: 0, text: "", items: [""] } },
        usage: { last: { inputTokens: 0, custom: { cache: 0 } } },
      },
      availability: [
        { path: "model.response.cost", reason: "source-unavailable" },
      ],
    });
  });

  it("omits a whole SDK value when JSON validation fails", () => {
    const cyclic: Record<string, unknown> = { kept: true };
    cyclic.self = cyclic;

    const observation = createCodexModelObservation({
      invocationId: "invocation-2",
      state: "succeeded",
      request: { input: [{ type: "text", text: "prompt" }] },
      response: { items: ["complete", undefined] },
      usage: cyclic,
    });

    expect(observation.model).not.toHaveProperty("response");
    expect(observation.model).not.toHaveProperty("usage");
    expect(observation.availability).toEqual(
      expect.arrayContaining([
        { path: "model.response", reason: "not-json-representable" },
        { path: "model.usage", reason: "not-json-representable" },
        { path: "model.response.cost", reason: "source-unavailable" },
      ]),
    );
  });
});
