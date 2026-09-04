import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as runtime from "./index.js";

describe("Seqlane runtime package root", () => {
  it("exposes engine APIs without child-runner APIs", () => {
    expect(runtime.compilePlan).toEqual(expect.any(Function));
    expect(runtime.startCompiledWorkflow).toEqual(expect.any(Function));
    expect(runtime).not.toHaveProperty("loadWorkflow");
    expect(runtime).not.toHaveProperty("startRunnerProcess");
  });

  it("keeps Mastra compiler types out of the public declaration", () => {
    const declaration = readFileSync(
      fileURLToPath(new URL("../dist/index.d.ts", import.meta.url)),
      "utf8",
    );

    expect(runtime).not.toHaveProperty("compilePlanToMastra");
    expect(runtime).not.toHaveProperty("compileBuiltWorkflowToMastra");
    expect(declaration).not.toContain("@mastra/");
    expect(declaration).not.toContain("compilePlanToMastra");
  });
});
