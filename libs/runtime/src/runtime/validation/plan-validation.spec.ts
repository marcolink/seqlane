// @test-scope ./plan-validation.ts

import type { Plan, RepeatNode, TaskNode, ValueBinding } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { PlanValidationError, validatePlan } from "./plan-validation.js";

const ref = (nodeId: string, path: readonly string[] = []): ValueBinding => ({
  type: "ref",
  nodeId,
  path: [...path],
});

const conditionRef = (
  nodeId: string,
  path: readonly string[] = [],
): RepeatNode["until"] => ref(nodeId, path) as RepeatNode["until"];

function repeat(overrides: Partial<RepeatNode> = {}): Plan {
  const attempt: TaskNode = {
    type: "task",
    taskId: "attempt-task",
    nodeId: "repeat:1:attempt",
    workspace: "exclusive",
    input: ref("repeat:1:input"),
    dependsOn: [],
  };
  return {
    workflow: { id: "repeat-validation" },
    nodes: [
      {
        type: "repeat",
        nodeId: "repeat:1",
        input: null,
        dependsOn: [],
        maximumIterations: 3,
        attempt,
        until: conditionRef(attempt.nodeId, ["output", "done"]),
        ...overrides,
      },
    ],
    output: ref("repeat:1", ["output"]),
  };
}

function issueCodes(plan: Plan): readonly string[] {
  try {
    validatePlan(plan, undefined, false);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(PlanValidationError);
    return (error as PlanValidationError).issues.map((issue) => issue.code);
  }
}

describe("repeat Plan validation", () => {
  it("accepts scoped attempt input, result condition, and next input", () => {
    const plan = repeat({
      nextInput: {
        value: ref("repeat:1:input", ["value"]),
        previous: ref("repeat:1:attempt", ["output"]),
      },
    });

    expect(issueCodes(plan)).toEqual([]);
  });

  it("rejects next-input references outside the attempt scope", () => {
    const plan = repeat({
      nextInput: ref("outside:1", ["output"]),
    });

    expect(issueCodes(plan)).toContain("invalid-repeat-reference");
  });

  it("accepts prior task outputs in until and next-input bindings", () => {
    const prior: TaskNode = {
      type: "task",
      taskId: "prior-task",
      nodeId: "prior",
      workspace: "shared",
      input: {},
      dependsOn: [],
    };
    const repeated = repeat({
      dependsOn: ["prior"],
      until: conditionRef("prior", ["output", "done"]),
      nextInput: {
        value: ref("prior", ["output", "value"]),
      },
    });
    const plan: Plan = { ...repeated, nodes: [prior, repeated.nodes[0]!] };

    expect(issueCodes(plan)).toEqual([]);
  });

  it("rejects current and future task references in repeat bindings", () => {
    const future: TaskNode = {
      type: "task",
      taskId: "future-task",
      nodeId: "future",
      workspace: "shared",
      input: {},
      dependsOn: [],
    };
    const repeated = repeat({
      dependsOn: ["future"],
      until: conditionRef("future", ["output", "done"]),
      nextInput: { value: ref("future", ["output", "value"]) },
    });
    const base: Plan = { ...repeated, nodes: [repeated.nodes[0]!, future] };

    expect(issueCodes(base)).toContain("invalid-repeat-condition");
    expect(issueCodes(base)).toContain("invalid-repeat-reference");
  });

  it("requires prior task references to be declared dependencies", () => {
    const prior: TaskNode = {
      type: "task",
      taskId: "prior-task",
      nodeId: "prior",
      workspace: "shared",
      input: {},
      dependsOn: [],
    };
    const repeated = repeat({
      until: conditionRef("prior", ["output", "done"]),
      nextInput: { value: ref("prior", ["output", "value"]) },
    });
    const plan: Plan = { ...repeated, nodes: [prior, repeated.nodes[0]!] };

    expect(issueCodes(plan)).toContain("missing-value-ref-dependency");
  });

  it("rejects a condition that reads the attempt input or an outer node", () => {
    expect(
      issueCodes(repeat({ until: conditionRef("repeat:1:input", ["done"]) })),
    ).toContain("invalid-repeat-condition");
    expect(
      issueCodes(
        repeat({ until: conditionRef("outside:1", ["output", "done"]) }),
      ),
    ).toContain("invalid-repeat-condition");
    expect(
      issueCodes(
        repeat({ until: conditionRef("repeat:1:attempt", ["input"]) }),
      ),
    ).toContain("invalid-repeat-condition");
  });

  it("rejects invalid limits and an attempt that escapes its input scope", () => {
    expect(issueCodes(repeat({ maximumIterations: 0 }))).toContain(
      "invalid-repeat-limit",
    );
    const baseAttempt = (repeat().nodes[0] as RepeatNode).attempt;
    const plan = repeat({
      attempt: {
        ...baseAttempt,
        input: ref("__seqlane_input"),
      },
    });
    expect(issueCodes(plan)).toContain("invalid-repeat-reference");
  });
});
