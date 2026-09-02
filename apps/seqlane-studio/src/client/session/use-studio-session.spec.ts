import { describe, expect, it } from "vitest";
import { resolveLiveRunId } from "./use-studio-session.js";

describe("resolveLiveRunId", () => {
  it("selects the first run that arrives after Studio opens", () => {
    expect(resolveLiveRunId(undefined, ["run-1"])).toBe("run-1");
  });

  it("preserves an explicit run selection", () => {
    expect(resolveLiveRunId("run-2", ["run-1", "run-2"])).toBe("run-2");
  });

  it("falls back when a stream reset removes the selected run", () => {
    expect(resolveLiveRunId("run-1", ["run-2"])).toBe("run-2");
  });
});
