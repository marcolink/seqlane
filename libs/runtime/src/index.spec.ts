import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as runtime from "./index.js";

describe("Seqlane runtime package root", () => {
  it("exposes Plan inspection without child-runner APIs", () => {
    expect(runtime.compilePlan).toEqual(expect.any(Function));
    expect(runtime).not.toHaveProperty("PlanCompiler");
    expect(runtime).not.toHaveProperty("startCompiledWorkflow");
    expect(runtime).not.toHaveProperty("runCompiledWorkflow");
    expect(runtime).not.toHaveProperty("loadWorkflow");
    expect(runtime).not.toHaveProperty("startRunnerProcess");
  });

  it("keeps runtime engine types out of the public declaration", () => {
    const declaration = readFileSync(
      fileURLToPath(new URL("../dist/index.d.ts", import.meta.url)),
      "utf8",
    );

    expect(declaration).not.toMatch(/(?:from|import\()[\s"']+effect(?:[/"'])/);
    expect(declaration).not.toContain("Effect.Effect");
    expect(declaration).not.toContain("Context.Service");
    expect(declaration).not.toMatch(
      /\b(?:PlanCompiler|CompiledPlan|CompileWorkflowOptions)\b/,
    );
  });
});
