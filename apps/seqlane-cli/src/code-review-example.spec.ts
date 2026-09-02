// @test-scope ../../../examples/code-review.ts

import { buildWorkflow } from "@seqlane/core";
import { describe, expect, it } from "vitest";

const { default: codeReviewWorkflow } = await import(
  new URL("../../../examples/code-review.ts", import.meta.url).href
);

describe("repository code review example workflow", () => {
  it("branches review lanes and reuses inspection for the final review", () => {
    const plan = buildWorkflow(codeReviewWorkflow).plan;
    const inspect = plan.nodes.find(
      (node) => node.type === "task" && node.taskId === "code-review.inspect",
    );
    const reviewLanes = plan.nodes.filter(
      (node) =>
        node.type === "task" &&
        [
          "code-review.correctness",
          "code-review.maintainability",
          "code-review.risk",
        ].includes(node.taskId),
    );
    const summarize = plan.nodes.find(
      (node) => node.type === "task" && node.taskId === "code-review.summarize",
    );

    expect(inspect).toBeDefined();
    expect(reviewLanes).toHaveLength(3);
    for (const reviewLane of reviewLanes) {
      expect(reviewLane).toMatchObject({
        session: { type: "branch", from: inspect?.nodeId },
      });
    }
    expect(summarize).toMatchObject({
      session: { type: "reuse", from: inspect?.nodeId },
    });
  });

  it("keeps every review task non-interactive", () => {
    const taskDefinitions = buildWorkflow(codeReviewWorkflow).taskDefinitions;
    const taskIds = [
      "code-review.inspect",
      "code-review.correctness",
      "code-review.maintainability",
      "code-review.risk",
      "code-review.summarize",
    ];

    for (const taskId of taskIds) {
      const task = taskDefinitions.get(taskId);
      expect(task).toBeDefined();
      if (task === undefined)
        throw new Error(`Missing task definition: ${taskId}`);

      expect(task.instructions).toContain(
        "Work non-interactively. Do not ask questions, solicit choices, use an ask or question tool, or wait for a response.",
      );
      expect(task.instructions).toContain(
        "When evidence is sufficient, return the final response immediately; the runtime validates it against the supplied output schema.",
      );
    }

    for (const taskId of [
      "code-review.inspect",
      "code-review.correctness",
      "code-review.maintainability",
      "code-review.risk",
    ]) {
      expect(taskDefinitions.get(taskId)?.workspace).toBe("shared");
    }
    expect(taskDefinitions.get("code-review.summarize")?.workspace).toBe(
      "shared",
    );

    expect(taskDefinitions.get("code-review.inspect")?.instructions).toContain(
      "Use only the approved read-only Git commands: git rev-parse HEAD, git diff --no-ext-diff --no-textconv HEAD^ HEAD, git diff --no-ext-diff --no-textconv --root HEAD, git status --short, git diff --no-ext-diff --no-textconv, git diff --no-ext-diff --no-textconv --cached, and git ls-files --others --exclude-standard.",
    );
  });
});
