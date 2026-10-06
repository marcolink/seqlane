// @test-scope ./plan-validation.ts
import { describe, expect, it } from "vitest";
import type { Plan, TaskNode } from "@seqlane/core";
import { validatePlan, PlanValidationError } from "./plan-validation.js";

function task(nodeId: string, dependsOn: readonly string[] = []): TaskNode {
  return {
    type: "task",
    nodeId,
    taskId: nodeId,
    input: {},
    workspace: "shared",
    dependsOn,
  };
}
function plan(
  policy: "reuse" | "fork",
  source: TaskNode,
  bridge?: TaskNode,
): Plan {
  return {
    workflow: { id: "choice-session" },
    nodes: [
      source,
      ...(bridge ? [bridge] : []),
      {
        type: "choice",
        nodeId: "choice:1",
        condition: { type: "ref", nodeId: "__seqlane_input", path: ["select"] },
        dependsOn: [],
        then: {
          ...task("choice:1:then", ["source"]),
          session: { type: policy, from: "source" },
        },
        else: task("choice:1:else"),
      },
    ],
    output: null,
  };
}
describe("choice session validation", () => {
  it.each(["reuse", "fork"] as const)(
    "rejects missing checkpoint source for %s",
    (policy) => {
      expect(() => validatePlan(plan(policy, task("source")))).toThrow(
        /invalid session source/,
      );
    },
  );
  it.each(["reuse", "fork"] as const)(
    "rejects direct and transitive session wait cycles for %s",
    (policy) => {
      for (const transitive of [false, true]) {
        const source = {
          ...task("source", [transitive ? "bridge" : "choice:1"]),
          session: { type: "isolated" as const },
        };
        try {
          validatePlan(
            plan(
              policy,
              source,
              transitive ? task("bridge", ["choice:1"]) : undefined,
            ),
          );
          expect.fail("Expected a cycle rejection");
        } catch (error) {
          expect(error).toBeInstanceOf(PlanValidationError);
          expect(error).toMatchObject({
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "dependency-cycle" }),
            ]),
          });
        }
      }
    },
  );
  it("keeps source waits out of choice eligibility", () => {
    const parsed = validatePlan(
      plan("fork", { ...task("source"), session: { type: "isolated" } }),
    );
    expect(parsed.nodes.at(-1)?.dependsOn).toEqual([]);
  });
});
