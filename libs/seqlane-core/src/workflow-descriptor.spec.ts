// @test-scope ./workflow-descriptor.ts

import { describe, expect, it } from "vitest";
import { workflowDescriptorSchema } from "./workflow-descriptor.js";

describe("workflow descriptor schema", () => {
  it("accepts the documented descriptor shape", () => {
    expect(
      workflowDescriptorSchema.parse({
        name: "review",
        moduleSpecifier: "./review.ts",
        exportName: "default",
        description: "Review a change",
      }),
    ).toEqual({
      name: "review",
      moduleSpecifier: "./review.ts",
      exportName: "default",
      description: "Review a change",
    });
  });

  it.each([
    { name: "", reason: "empty name" },
    { name: "review/name", reason: "invalid name" },
    { exportName: "", reason: "empty export name" },
    { moduleSpecifier: "", reason: "empty module specifier" },
    { description: "", reason: "empty description" },
  ])("rejects $reason", (override) => {
    const descriptor = {
      name: "review",
      moduleSpecifier: "./review.ts",
      exportName: "default",
      description: "Review a change",
      ...override,
    };

    expect(workflowDescriptorSchema.safeParse(descriptor).success).toBe(false);
  });

  it("rejects unknown properties", () => {
    expect(
      workflowDescriptorSchema.safeParse({
        name: "review",
        moduleSpecifier: "./review.ts",
        exportName: "default",
        description: "Review a change",
        scope: "repository",
      }).success,
    ).toBe(false);
  });
});
