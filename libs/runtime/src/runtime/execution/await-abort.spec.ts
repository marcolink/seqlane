import { getEventListeners } from "node:events";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { awaitAbort } from "./await-abort.js";

describe("native abort signal boundary", () => {
  it.each([null, false, 0, undefined, new Error("cancelled")])(
    "handles cancellation during listener registration (%s)",
    async (reason) => {
      const controller = new AbortController();
      const signal = controller.signal;
      if (reason === undefined)
        Object.defineProperty(signal, "reason", { value: undefined });
      const add = signal.addEventListener.bind(signal);
      vi.spyOn(signal, "addEventListener").mockImplementationOnce((...args) => {
        controller.abort(reason);
        add(...args);
      });
      await expect(
        Effect.runPromise(awaitAbort(signal, "cancelled")),
      ).rejects.toBe(signal.reason);
      expect(getEventListeners(signal, "abort")).toEqual([]);
    },
  );
});
