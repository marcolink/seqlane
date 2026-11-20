// @test-scope ./schemas.ts
import { defineTask } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createObserver } from "./observations.js";
import { messageSchema } from "./schemas.js";

function fixture() {
  const onActivity = vi.fn();
  const onObservation = vi.fn();
  const onMetrics = vi.fn();
  const controller = new AbortController();
  const observer = createObserver(
    {
      invocationId: "invocation",
      task: defineTask({
        id: "activity",
        input: z.object({}),
        output: z.object({}),
        execute: async () => ({}),
      }),
      input: {},
      signal: controller.signal,
      onExecutionStarted: () => undefined,
      onActivity,
      onObservation,
      onMetrics,
    },
    (text) => text.replaceAll("secret", "[REDACTED]"),
  );
  return { observer, controller, onActivity, onObservation, onMetrics };
}

function message(
  status: string,
  input: unknown = { path: "first" },
  completed = false,
) {
  return messageSchema.parse({
    id: "assistant",
    type: "assistant",
    model: { providerID: "fixture", id: "model" },
    time: { created: 1, ...(completed ? { completed: 3 } : {}) },
    cost: 0.01,
    content: [
      {
        type: "reasoning",
        text: "reason secret",
        time: { created: 1, completed: 2 },
      },
      {
        type: "tool",
        id: "tool",
        name: "read",
        time: { created: 1, ...(completed ? { completed: 2 } : {}) },
        state: {
          status,
          input,
          content: [{ type: "text", text: "result secret" }],
          metadata: { nested: { value: "secret" } },
        },
      },
      { type: "text", text: "answer secret" },
    ],
  });
}

describe("OpenCode V2 observations", () => {
  it("reports changed tool details while running and emits each terminal state once", () => {
    const h = fixture();
    const first = message("running");
    h.observer.observe([first, first]);
    h.observer.observe([message("running", { path: "second secret" })]);
    const terminal = message("completed", { path: "second secret" }, true);
    h.observer.observe([terminal, terminal, first]);
    h.observer.finish();
    expect(h.onActivity.mock.calls.map(([activity]) => activity.state)).toEqual(
      ["started", "progress", "succeeded"],
    );
    expect(h.onActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: { path: "second [REDACTED]" },
        output: [{ type: "text", text: "result [REDACTED]" }],
        metadata: { nested: { value: "[REDACTED]" } },
        endedAt: 2,
      }),
    );
    expect(h.onObservation).toHaveBeenCalledTimes(1);
    expect(h.onMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 0.01 }),
    );
  });

  it("preserves reasoning and tool content in the canonical model observation", () => {
    const h = fixture();
    h.observer.observe([message("completed", { path: "secret" }, true)]);
    const observation = h.onObservation.mock.calls[0]?.[0];
    expect(observation.model.response.content).toEqual(
      expect.arrayContaining([
        {
          type: "reasoning",
          text: "reason [REDACTED]",
          time: { created: 1, completed: 2 },
        },
        expect.objectContaining({
          type: "tool",
          state: expect.objectContaining({ input: { path: "[REDACTED]" } }),
        }),
      ]),
    );
    expect(JSON.stringify(observation)).not.toContain("secret");
  });

  it("cancellation terminates unfinished activity with its most recent details", () => {
    const h = fixture();
    h.observer.observe([message("running", { path: "first" })]);
    h.observer.observe([message("running", { path: "second" })]);
    h.controller.abort();
    h.observer.finish();
    h.observer.finish();
    expect(h.onActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "failed",
        input: { path: "second" },
        message: "Tool activity cancelled",
      }),
    );
    expect(h.onActivity).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed reasoning before reporting observations", () => {
    expect(() =>
      messageSchema.parse({
        id: "assistant",
        type: "assistant",
        model: { providerID: "fixture", id: "model" },
        time: { created: 1 },
        content: [{ type: "reasoning", text: 123 }],
      }),
    ).toThrow();
  });
});
