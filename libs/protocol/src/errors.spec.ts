// @test-scope ./errors.ts
// @test-scope ./validation.ts

import { describe, expect, it } from "vitest";
import { serializeSeqlaneError } from "./errors.js";

describe("serializeSeqlaneError", () => {
  it("serializes validated validation metadata from an Error", () => {
    const error = Object.assign(new Error("Validation failed"), {
      category: "ValidationError",
      taskId: "task-1",
      nodeId: "validation.gate:1",
      sourceId: "validator-1",
      issues: [{ code: "unsafe", message: "Unsafe result" }],
    });

    expect(serializeSeqlaneError(error)).toEqual({
      category: "ValidationError",
      message: "Validation failed",
      taskId: "task-1",
      validation: {
        validationNodeId: "validation.gate:1",
        sourceId: "validator-1",
        issues: [{ code: "unsafe", message: "Unsafe result" }],
      },
    });
  });

  it("preserves valid error metadata when validation fields are malformed", () => {
    const error = Object.assign(new Error("Validation failed"), {
      category: "ValidationError",
      taskId: "task-1",
      nodeId: "validation.gate:1",
      sourceId: "validator-1",
      issues: [{ code: 42, message: "not a string" }],
    });

    expect(serializeSeqlaneError(error)).toEqual({
      category: "ValidationError",
      message: "Validation failed",
      taskId: "task-1",
    });
  });

  it("does not serialize an empty validation issue list", () => {
    const error = Object.assign(new Error("Validation failed"), {
      category: "ValidationError",
      taskId: "task-1",
      nodeId: "validation.gate:1",
      sourceId: "validator-1",
      issues: [],
    });

    expect(serializeSeqlaneError(error)).toEqual({
      category: "ValidationError",
      message: "Validation failed",
      taskId: "task-1",
    });
  });
});
