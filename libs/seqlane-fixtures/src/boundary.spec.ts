// @test-scope ./validation-workflow.ts
// @test-scope ./model-selection-workflow.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(`${packageRoot}/package.json`, "utf8"),
) as { readonly exports?: Record<string, unknown> };

describe("fixture package boundary", () => {
  it("declares the validation fixture as an intentional subpath", () => {
    expect(Object.keys(manifest.exports ?? {})).toEqual([
      "./renovate-workflow",
      "./renovate-fake-workflow",
      "./mixed-workflow",
      "./validation-workflow",
      "./model-selection-workflow",
    ]);
    expect(manifest.exports?.["./validation-workflow"]).toMatchObject({
      import: "./dist/validation-workflow.js",
      types: "./dist/validation-workflow.d.ts",
    });
  });

  it("declares the model-selection fixture as an intentional subpath", () => {
    expect(manifest.exports?.["./model-selection-workflow"]).toMatchObject({
      import: "./dist/model-selection-workflow.js",
      types: "./dist/model-selection-workflow.d.ts",
    });
  });

  it("rejects package-root and source-file imports", () => {
    expect(manifest.exports?.["."]).toBeUndefined();
    expect(Object.keys(manifest.exports ?? {})).not.toContain(
      "./src/validation-workflow",
    );
  });
});
