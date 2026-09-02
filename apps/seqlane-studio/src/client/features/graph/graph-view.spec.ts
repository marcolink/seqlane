import type {
  StudioRunSnapshot,
  StudioRunState,
} from "@seqlane/studio/protocol";
import { describe, expect, it } from "vitest";
import {
  focusInvocationId,
  shouldRefitGraph,
  studioGraphViewport,
} from "./graph-view.js";

describe("graph viewport", () => {
  it("fits the first selected run", () => {
    expect(
      shouldRefitGraph(undefined, { runId: "run-1", state: "active" }),
    ).toBe(true);
  });

  it("fits when the selected run changes", () => {
    expect(
      shouldRefitGraph(
        { runId: "run-1", state: "active" },
        { runId: "run-2", state: "active" },
      ),
    ).toBe(true);
  });

  it("fits when a run becomes terminal, but not on every terminal update", () => {
    const active = { runId: "run-1", state: "active" as StudioRunState };
    const succeeded = {
      runId: "run-1",
      state: "succeeded" as StudioRunState,
    };

    expect(shouldRefitGraph(active, succeeded)).toBe(true);
    expect(shouldRefitGraph(succeeded, succeeded)).toBe(false);
  });

  it("allows fit view to zoom out for large execution graphs", () => {
    expect(studioGraphViewport.minZoom).toBeLessThan(0.5);
    expect(studioGraphViewport.initialMinZoom).toBeGreaterThanOrEqual(0.6);
    expect(studioGraphViewport.padding).toBeGreaterThan(0);
  });

  it("focuses the active invocation before falling back to selection", () => {
    const invocations = [
      { invocationId: "done", state: "succeeded" },
      { invocationId: "running", state: "active" },
    ] as unknown as StudioRunSnapshot["invocations"];

    expect(focusInvocationId(invocations, "done")).toBe("running");
    expect(focusInvocationId([], "done")).toBe("done");
  });

  it("falls back to the latest invocation when none is active or selected", () => {
    const invocations = [
      { invocationId: "first", state: "succeeded" },
      { invocationId: "latest", state: "succeeded" },
    ] as unknown as StudioRunSnapshot["invocations"];

    expect(focusInvocationId(invocations, undefined)).toBe("latest");
  });
});
