import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ChoiceSourceGate } from "./choice-source-gate.js";

describe("choice session source gate", () => {
  it("waits for source success and rejects failed or cancelled waits", async () => {
    const gate = new ChoiceSourceGate();
    gate.register("source", "source-invocation");
    const waiting = Effect.runPromise(
      gate.waitEffect("source", new AbortController().signal),
    );
    gate.observe({
      type: "invocation.succeeded",
      workId: "work",
      runId: "run",
      invocationId: "source-invocation",
    });
    await expect(waiting).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(
        gate.waitEffect("source", new AbortController().signal),
      ),
    ).resolves.toBeUndefined();

    const failed = new ChoiceSourceGate();
    failed.register("source", "failed-invocation");
    failed.observe({
      type: "invocation.skipped",
      workId: "work",
      runId: "run",
      invocationId: "failed-invocation",
      reason: "upstream failed",
      dependencyIds: [],
    });
    await expect(
      Effect.runPromise(
        failed.waitEffect("source", new AbortController().signal),
      ),
    ).rejects.toThrow('Choice session source "source" did not succeed');

    const cancelled = new ChoiceSourceGate();
    cancelled.register("source", "cancelled-invocation");
    const controller = new AbortController();
    const cancelledWait = Effect.runPromise(
      cancelled.waitEffect("source", controller.signal),
    );
    controller.abort(new Error("run cancelled"));
    await expect(cancelledWait).rejects.toThrow("run cancelled");
  });

  it("lets cancellation win while a selected source is still pending", async () => {
    const gate = new ChoiceSourceGate();
    gate.register("source", "source-invocation");
    const controller = new AbortController();
    const waiting = Effect.runPromise(
      gate.waitEffect("source", controller.signal),
    );
    controller.abort(new Error("run cancelled"));
    await expect(waiting).rejects.toThrow("run cancelled");
  });
});
