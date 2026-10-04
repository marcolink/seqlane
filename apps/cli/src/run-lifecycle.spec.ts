// @test-scope ./run-cleanup.ts
import { describe, expect, it, vi } from "vitest";
import { closeRunResources } from "./run-lifecycle.js";

describe("closeRunResources", () => {
  it("attempts worker, event, and renderer cleanup even after each fails", async () => {
    const order: string[] = [];
    const errors = [
      new Error("client"),
      new Error("flush"),
      new Error("events"),
      new Error("renderer"),
    ];
    const fail = (index: number) => async () => {
      const error = errors[index];
      if (error === undefined) throw new Error("Invalid fixture index");
      order.push(error.message);
      throw error;
    };
    const result = await closeRunResources({
      closeClient: fail(0),
      dispatcher: { consume: vi.fn(), flush: fail(1), close: fail(2) },
      finishRenderer: fail(3),
    });
    expect(result).toEqual(errors);
    expect(order).toEqual(["client", "flush", "events", "renderer"]);
  });
  it("returns each renderer cleanup failure once", async () => {
    const error = new Error("renderer");
    expect(
      await closeRunResources({
        finishRenderer: async () => {
          throw error;
        },
      }),
    ).toEqual([error]);
  });
});
