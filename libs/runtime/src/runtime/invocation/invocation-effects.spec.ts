import { describe, expect, it } from "vitest";
import { InvocationEffects } from "./invocation-effects.js";

async function expectPending(promise: Promise<unknown>) {
  await expect(
    Promise.race([
      promise.then(() => "complete"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]),
  ).resolves.toBe("pending");
}

describe("InvocationEffects", () => {
  it("waits for a started activity to terminate", async () => {
    const effects = new InvocationEffects();
    effects.observeActivity({ activityId: "tool-1", state: "started" });

    const termination = effects.waitForTermination();
    await expectPending(termination);

    effects.observeActivity({ activityId: "tool-1", state: "succeeded" });
    await termination;
  });

  it("waits for tracked child and process lifetimes to terminate", async () => {
    const effects = new InvocationEffects();
    let finishChild!: () => void;
    let finishProcess!: () => void;
    const childTermination = new Promise<void>((resolve) => {
      finishChild = resolve;
    });
    const processTermination = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });

    effects.track({ type: "child", termination: childTermination });
    effects.track({ type: "process", termination: processTermination });

    const termination = effects.waitForTermination();
    await expectPending(termination);

    finishChild();
    await expectPending(termination);

    finishProcess();
    await termination;
  });
});
