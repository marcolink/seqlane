import type { ValueBinding } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import {
  BindingResolutionError,
  referencedNodeIds,
  resolveBinding,
  WORKFLOW_INPUT_NODE_ID,
} from "./binding-resolution.js";

describe("resolveBinding", () => {
  it("preserves literal values in nested objects and arrays", () => {
    const binding: ValueBinding = {
      literal: "value",
      nested: [{ count: 1 }, [true, null]],
    };

    expect(resolveBinding(binding, {}, new Map())).toEqual({
      literal: "value",
      nested: [{ count: 1 }, [true, null]],
    });
  });

  it("resolves a workflow-input reference through nested arrays", () => {
    const binding: ValueBinding = {
      type: "ref",
      nodeId: WORKFLOW_INPUT_NODE_ID,
      path: ["request", "items", "1", "name"],
    };

    expect(
      resolveBinding(
        binding,
        { request: { items: [{ name: "first" }, { name: "second" }] } },
        new Map(),
      ),
    ).toBe("second");
  });

  it("resolves a prior invocation result", () => {
    const binding: ValueBinding = {
      type: "ref",
      nodeId: "investigate:1",
      path: ["output", "plan", "steps", "0"],
    };

    expect(
      resolveBinding(
        binding,
        {},
        new Map([
          ["investigate:1", { output: { plan: { steps: ["inspect"] } } }],
        ]),
      ),
    ).toBe("inspect");
  });

  it("resolves typed output paths against raw runtime results", () => {
    const binding: ValueBinding = {
      type: "ref",
      nodeId: "investigate:1",
      path: ["output", "files"],
    };

    expect(
      resolveBinding(
        binding,
        {},
        new Map([["investigate:1", { files: ["package.json"] }]]),
      ),
    ).toEqual(["package.json"]);
  });

  it("rejects a reference with a missing path", () => {
    const binding: ValueBinding = {
      type: "ref",
      nodeId: WORKFLOW_INPUT_NODE_ID,
      path: ["missing"],
    };

    expect(() => resolveBinding(binding, {}, new Map())).toThrow(
      BindingResolutionError,
    );
  });
});

describe("referencedNodeIds", () => {
  it("returns one consumer source for repeated references in a binding", () => {
    expect(
      referencedNodeIds({
        first: { type: "ref", nodeId: "source", path: ["first"] },
        second: { type: "ref", nodeId: "source", path: ["second"] },
      }),
    ).toEqual(new Set(["source"]));
  });
});
