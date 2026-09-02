import { describe, expect, it } from "vitest";
import * as runtime from "./index.js";

describe("Seqlane runtime package root", () => {
  it("exposes engine APIs without child-runner APIs", () => {
    expect(runtime.compilePlan).toEqual(expect.any(Function));
    expect(runtime.startCompiledWorkflow).toEqual(expect.any(Function));
    expect(runtime).not.toHaveProperty("loadWorkflow");
    expect(runtime).not.toHaveProperty("startRunnerProcess");
  });
});
