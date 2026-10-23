// @test-scope ./effect-plan.ts
import { describe, expect, it } from "vitest";
import { UnconfirmedInvocationTerminationError } from "./executor.js";
import { resolveGraphFailure } from "./effect-plan.js";

describe("Effect Plan graph failure resolution", () => {
  it("keeps a later uncertain termination ahead of an earlier cancellation", () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = new Error("ordinary task cancellation");
    const uncertain = new UnconfirmedInvocationTerminationError("disconnect");

    const result = resolveGraphFailure("workflow", controller.signal, [
      { status: "failed", error: cancelled },
      { status: "failed", error: uncertain },
    ]);

    expect(result).toMatchObject({
      status: "failed",
      error: { name: "RuntimeError", cause: uncertain },
    });
  });
});
