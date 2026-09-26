// @test-scope ./start-workflow-run.ts
// @test-scope ./runtime/mastra/mastra-execution.ts
// @test-scope ./runtime/compile/mastra-choice-compiler.ts

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildWorkflow,
  createFlow,
  defineTask,
  defineValidator,
  type SeqlaneEvent,
} from "@seqlane/core";
import { startWorkflowRun } from "./start-workflow-run.js";

const input = z.object({ review: z.boolean(), change: z.string() });
const reviewed = z.object({ kind: z.literal("reviewed"), risk: z.number() });
const approved = z.object({ kind: z.literal("approved"), reason: z.string() });
const output = z.discriminatedUnion("kind", [reviewed, approved]);

describe("exclusive Flow choice through the runtime", () => {
  it.each([
    [true, { kind: "reviewed", risk: 1 }, "review", "approve"],
    [false, { kind: "approved", reason: "normal" }, "approve", "review"],
  ])(
    "runs the %s path and skips the other",
    async (review, expected, selected, unselected) => {
      const calls: string[] = [];
      const reviewTask = defineTask({
        id: "review",
        input: z.object({ change: z.string() }),
        output: reviewed,
        execute: async () => {
          calls.push("review");
          return { kind: "reviewed" as const, risk: 1 };
        },
      });
      const approveTask = defineTask({
        id: "approve",
        input: z.object({ change: z.string() }),
        output: approved,
        execute: async () => {
          calls.push("approve");
          return { kind: "approved" as const, reason: "normal" };
        },
      });
      const flow = createFlow({ id: "runtime-choice", input, output })
        .when(({ input: value }) => value.review)
        .task("decision", reviewTask, ({ input: value }) => ({
          change: value.change,
        }))
        .otherwise(approveTask, ({ input: value }) => ({
          change: value.change,
        }))
        .output(({ tasks }) => tasks.decision.output)
        .define();
      const events: SeqlaneEvent[] = [];
      const run = startWorkflowRun({
        workflow: buildWorkflow(flow),
        input: { review, change: "a" },
        workspace: process.cwd(),
        identity: { workId: "choice-work", runId: `choice-run-${review}` },
        events: { emit: (event) => events.push(event) },
      });

      await expect(run.outcome).resolves.toMatchObject({
        status: "succeeded",
        result: expected,
      });
      expect(calls).toEqual([selected]);
      const unselectedPlanNodeId = `choice:1:${unselected === "review" ? "then" : "else"}`;
      const unselectedInvocation = events.find(
        (
          event,
        ): event is Extract<
          (typeof events)[number],
          { type: "invocation.created" }
        > =>
          event.type === "invocation.created" &&
          event.planNodeId === unselectedPlanNodeId,
      );
      expect(unselectedInvocation).toBeDefined();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "invocation.skipped",
          invocationId: unselectedInvocation?.invocationId,
          reason: "Choice arm not selected",
        }),
      );
    },
  );

  it("runs a selected child workflow with its own invocation identity", async () => {
    const calls: string[] = [];
    const reviewTask = defineTask({
      id: "nested-review",
      input: z.object({ change: z.string() }),
      output: reviewed,
      execute: async () => {
        calls.push("nested-review");
        return { kind: "reviewed" as const, risk: 2 };
      },
    });
    const approveTask = defineTask({
      id: "plain-approve",
      input: z.object({ change: z.string() }),
      output: approved,
      execute: async () => {
        calls.push("plain-approve");
        return { kind: "approved" as const, reason: "normal" };
      },
    });
    const child = createFlow({
      id: "review-child",
      input: z.object({ change: z.string() }),
      output: reviewed,
    })
      .task("review", reviewTask, ({ input: value }) => value)
      .output(({ tasks }) => tasks.review.output)
      .define();
    const parent = createFlow({ id: "choice-child-parent", input, output })
      .when(({ input: value }) => value.review)
      .task("decision", child, ({ input: value }) => ({
        change: value.change,
      }))
      .otherwise(approveTask, ({ input: value }) => ({
        change: value.change,
      }))
      .output(({ tasks }) => tasks.decision.output)
      .define();
    const events: SeqlaneEvent[] = [];
    const run = startWorkflowRun({
      workflow: buildWorkflow(parent),
      input: { review: true, change: "a" },
      workspace: process.cwd(),
      identity: { workId: "choice-child-work", runId: "choice-child-run" },
      events: { emit: (event) => events.push(event) },
    });

    await expect(run.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: { kind: "reviewed", risk: 2 },
    });
    expect(calls).toEqual(["nested-review"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.created",
        planNodeId: "choice:1:then",
        kind: "workflow",
        subject: { type: "task", taskId: "review-child" },
      }),
    );
  });

  it("fails on the selected arm without starting the other arm", async () => {
    let approvals = 0;
    const failingReview = defineTask({
      id: "failing-review",
      input: z.object({ change: z.string() }),
      output: reviewed,
      execute: async () => {
        throw new Error("review failed");
      },
    });
    const approve = defineTask({
      id: "fallback-approval",
      input: z.object({ change: z.string() }),
      output: approved,
      execute: async () => {
        approvals += 1;
        return { kind: "approved" as const, reason: "normal" };
      },
    });
    const flow = createFlow({ id: "choice-failure", input, output })
      .when(({ input: value }) => value.review)
      .task("decision", failingReview, ({ input: value }) => ({
        change: value.change,
      }))
      .otherwise(approve, ({ input: value }) => ({ change: value.change }))
      .output(({ tasks }) => tasks.decision.output)
      .define();
    const events: SeqlaneEvent[] = [];
    const run = startWorkflowRun({
      workflow: buildWorkflow(flow),
      input: { review: true, change: "a" },
      workspace: process.cwd(),
      identity: { workId: "choice-fail-work", runId: "choice-fail-run" },
      events: { emit: (event) => events.push(event) },
    });

    await expect(run.outcome).resolves.toMatchObject({ status: "failed" });
    expect(approvals).toBe(0);
    expect(events.some((event) => event.type === "invocation.skipped")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "invocation.failed")).toBe(
      true,
    );
  });

  it("passes the selected output to a downstream task", async () => {
    const decide = defineTask({
      id: "decide-review",
      input: z.object({ change: z.string() }),
      output: z.object({ review: z.boolean() }),
      execute: async () => ({ review: false }),
    });
    const review = defineTask({
      id: "downstream-review",
      input: z.object({ change: z.string() }),
      output: reviewed,
      execute: async () => ({ kind: "reviewed" as const, risk: 1 }),
    });
    const approve = defineTask({
      id: "downstream-approve",
      input: z.object({ change: z.string() }),
      output: approved,
      execute: async () => ({ kind: "approved" as const, reason: "normal" }),
    });
    const publish = defineTask({
      id: "publish-decision",
      input: output,
      output: z.object({ summary: z.string() }),
      execute: async ({ input: selected }) => ({ summary: selected.kind }),
    });
    const flow = createFlow({
      id: "choice-downstream",
      input: z.object({ change: z.string() }),
      output: z.object({ summary: z.string() }),
    })
      .task("decider", decide, ({ input: value }) => value)
      .when(({ tasks }) => tasks.decider.output.review)
      .task("decision", review, ({ input: value }) => value)
      .otherwise(approve, ({ input: value }) => value)
      .task("publish", publish, ({ tasks }) => tasks.decision.output)
      .output(({ tasks }) => tasks.publish.output)
      .define();
    const run = startWorkflowRun({
      workflow: buildWorkflow(flow),
      input: { change: "a" },
      workspace: process.cwd(),
      identity: {
        workId: "choice-downstream-work",
        runId: "choice-downstream-run",
      },
      events: { emit: () => undefined },
    });
    await expect(run.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: { summary: "approved" },
    });
  });

  it("validates only the selected task output", async () => {
    const calls: string[] = [];
    const review = defineTask({
      id: "validated-review",
      input: z.object({ change: z.string() }),
      output: reviewed,
      execute: async () => ({ kind: "reviewed" as const, risk: 1 }),
    });
    const approve = defineTask({
      id: "validated-approve",
      input: z.object({ change: z.string() }),
      output: approved,
      execute: async () => ({ kind: "approved" as const, reason: "normal" }),
    });
    const reject = defineValidator({
      id: "reject-review",
      input: reviewed,
      validate: () => {
        calls.push("review-validator");
        return {
          success: false as const,
          issues: [{ code: "rejected", message: "review rejected" }],
        };
      },
    });
    const accept = defineValidator({
      id: "accept-approval",
      input: approved,
      validate: () => {
        calls.push("approval-validator");
        return { success: true as const, issues: [] };
      },
    });
    const flow = createFlow({ id: "choice-validation", input, output })
      .when(({ input: value }) => value.review)
      .task(
        "decision",
        review,
        ({ input: value }) => ({ change: value.change }),
        { validateOutput: reject },
      )
      .otherwise(approve, ({ input: value }) => ({ change: value.change }), {
        validateOutput: accept,
      })
      .output(({ tasks }) => tasks.decision.output)
      .define();
    const built = buildWorkflow(flow);
    const run = (reviewValue: boolean) =>
      startWorkflowRun({
        workflow: built,
        input: { review: reviewValue, change: "a" },
        workspace: process.cwd(),
        identity: {
          workId: "choice-validation-work",
          runId: `choice-validation-${reviewValue}`,
        },
        events: { emit: () => undefined },
      });
    await expect(run(false).outcome).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(calls).toEqual(["approval-validator"]);
    await expect(run(true).outcome).resolves.toMatchObject({
      status: "failed",
    });
    expect(calls).toEqual(["approval-validator", "review-validator"]);
  });

  it("cancels the selected arm without starting the other arm", async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let otherCalls = 0;
    const slow = defineTask({
      id: "slow-choice-task",
      input: z.object({ change: z.string() }),
      output: reviewed,
      execute: async ({ signal }) => {
        markStarted();
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    const other = defineTask({
      id: "unused-choice-task",
      input: z.object({ change: z.string() }),
      output: approved,
      execute: async () => {
        otherCalls += 1;
        return { kind: "approved" as const, reason: "normal" };
      },
    });
    const flow = createFlow({ id: "choice-cancel", input, output })
      .when(({ input: value }) => value.review)
      .task("decision", slow, ({ input: value }) => ({ change: value.change }))
      .otherwise(other, ({ input: value }) => ({ change: value.change }))
      .output(({ tasks }) => tasks.decision.output)
      .define();
    const events: SeqlaneEvent[] = [];
    const run = startWorkflowRun({
      workflow: buildWorkflow(flow),
      input: { review: true, change: "a" },
      workspace: process.cwd(),
      identity: { workId: "choice-cancel-work", runId: "choice-cancel-run" },
      events: { emit: (event) => events.push(event) },
    });
    await started;
    await run.cancel();
    await expect(run.outcome).resolves.toMatchObject({ status: "cancelled" });
    expect(otherCalls).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.cancelled",
        reason: "Choice cancelled",
      }),
    );
  });

  it("lets independent shared-workspace work run beside the selected arm", async () => {
    let startedCount = 0;
    let markBothStarted: () => void = () => undefined;
    let releaseTasks: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseTasks = resolve;
    });
    const execute = async () => {
      startedCount += 1;
      if (startedCount === 2) markBothStarted();
      await gate;
    };
    const independent = defineTask({
      id: "choice-independent",
      input: z.object({ change: z.string() }),
      output: z.object({ done: z.boolean() }),
      execute: async () => {
        await execute();
        return { done: true };
      },
    });
    const review = defineTask({
      id: "choice-concurrent-review",
      input: z.object({ change: z.string() }),
      output: reviewed,
      execute: async () => {
        await execute();
        return { kind: "reviewed" as const, risk: 1 };
      },
    });
    const approve = defineTask({
      id: "choice-concurrent-approve",
      input: z.object({ change: z.string() }),
      output: approved,
      execute: async () => ({ kind: "approved" as const, reason: "normal" }),
    });
    const flow = createFlow({ id: "choice-concurrent", input, output })
      .task(
        "independent",
        independent,
        ({ input: value }) => ({ change: value.change }),
        { workspace: "shared" },
      )
      .when(({ input: value }) => value.review)
      .task(
        "decision",
        review,
        ({ input: value }) => ({ change: value.change }),
        { workspace: "shared" },
      )
      .otherwise(approve, ({ input: value }) => ({ change: value.change }), {
        workspace: "shared",
      })
      .output(({ tasks }) => tasks.decision.output)
      .define();
    const run = startWorkflowRun({
      workflow: buildWorkflow(flow),
      input: { review: true, change: "a" },
      workspace: process.cwd(),
      identity: {
        workId: "choice-concurrent-work",
        runId: "choice-concurrent-run",
      },
      events: { emit: () => undefined },
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bothStarted,
        new Promise<never>(
          (_, reject) =>
            (timeout = setTimeout(
              () =>
                reject(
                  new Error("Independent work did not start concurrently"),
                ),
              2000,
            )),
        ),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      releaseTasks();
    }
    await expect(run.outcome).resolves.toMatchObject({ status: "succeeded" });
    expect(startedCount).toBe(2);
  });
});
