// @test-scope ./schemas.ts
import { defineTask } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createObserver } from "./observations.js";
import { OpenCodeV2Error } from "./errors.js";
import { messageSchema } from "./schemas.js";

function fixture(sink?: (event: unknown) => void) {
  const onActivity = vi.fn();
  const onObservation = vi.fn();
  if (sink !== undefined) {
    onActivity.mockImplementation(sink);
    onObservation.mockImplementation(sink);
  }
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
  content: unknown = [{ type: "text", text: "result secret" }],
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
          content,
          metadata: { nested: { value: "secret" } },
        },
      },
      { type: "text", text: "answer secret" },
    ],
  });
}

describe("OpenCode V2 observations", () => {
  it.each([false, true])(
    "rejects non-JSON tool data before batch callbacks, completed=%s",
    (completed) => {
      const h = fixture();
      const unsafe = message(
        completed ? "completed" : "running",
        { overflow: Infinity },
        completed,
      );
      expect(() =>
        h.observer.observe([message("completed", {}, true), unsafe]),
      ).toThrow(
        new OpenCodeV2Error(
          "protocol",
          "native observation contains invalid JSON data",
        ),
      );
      h.observer.finish();
      expect(h.onActivity).not.toHaveBeenCalled();
      expect(h.onObservation).not.toHaveBeenCalled();
      expect(h.onMetrics).not.toHaveBeenCalled();
    },
  );
  it.each(["input", "content", "metadata"] as const)(
    "rejects credential-bearing nested %s keys before activity or model emission",
    (field) => {
      for (const completed of [false, true]) {
        const h = fixture();
        const unsafe = message(
          completed ? "completed" : "running",
          {},
          completed,
        );
        const tool =
          unsafe.type === "assistant" ? unsafe.content[1] : undefined;
        if (tool?.type !== "tool") throw new Error("missing fixture tool");
        const nested = { wrapper: [{ "prefix-secret-suffix": "detail" }] };
        if (field === "content") tool.state.content = [nested];
        else tool.state[field] = nested;
        expect(() =>
          h.observer.observe([message("completed", {}, true), unsafe]),
        ).toThrow(
          new OpenCodeV2Error(
            "protocol",
            "native observation contains a credential in a property name",
          ),
        );
        h.observer.finish();
        expect(h.onActivity).not.toHaveBeenCalled();
        expect(h.onObservation).not.toHaveBeenCalled();
        expect(h.onMetrics).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["input", "content", "metadata"] as const)(
    "rejects deep tool %s with a validation error before observation",
    (field) => {
      let nested: unknown = "secret";
      for (let index = 0; index < 20_000; index++) nested = { nested };
      const parsed = messageSchema.safeParse({
        id: "assistant",
        type: "assistant",
        model: { providerID: "fixture", id: "model" },
        time: { created: 1 },
        content: [
          {
            type: "tool",
            id: "deep",
            name: "read",
            time: { created: 1 },
            state: {
              status: "running",
              [field]: field === "content" ? [nested] : { nested },
            },
          },
        ],
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBeInstanceOf(z.ZodError);
      expect(parsed.error?.message).toContain("depth or node limit");
    },
  );

  it("rejects overly broad tool values before recursive processing", () => {
    expect(() =>
      message("running", { items: Array(65_536).fill(null) }),
    ).toThrow("depth or node limit");
  });

  it("keeps growing output within a slow event sink's pending byte budget", () => {
    const limit = 2 * 1024 * 1024;
    let pendingBytes = 0;
    let overflow = false;
    const h = fixture((event) => {
      pendingBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
      if (pendingBytes > limit) {
        overflow = true;
        throw new Error("event sink pending byte limit exceeded");
      }
    });
    const output = (size: number) => [{ type: "text", text: "x".repeat(size) }];
    for (let index = 1; index <= 128; index++)
      h.observer.observe([message("running", {}, false, output(index * 4096))]);
    h.observer.observe([message("completed", {}, true, output(128 * 4096))]);
    h.observer.finish();
    expect(overflow).toBe(false);
    expect(pendingBytes).toBeLessThan(limit);
    const progress = h.onActivity.mock.calls.flatMap(([activity]) =>
      activity.state === "progress" ? [activity] : [],
    );
    expect(progress).toHaveLength(127);
    expect(
      progress.every(
        (activity) => Buffer.byteLength(JSON.stringify(activity)) < 1024,
      ),
    ).toBe(true);
    expect(h.onActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "succeeded",
        output: output(128 * 4096),
      }),
    );
    expect(h.onObservation.mock.calls[0]?.[0].model.response.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool",
          state: expect.objectContaining({ content: output(128 * 4096) }),
        }),
      ]),
    );
  });

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
