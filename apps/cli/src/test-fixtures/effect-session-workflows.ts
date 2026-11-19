import {
  createFlow,
  defineAgentTask,
  fork,
  isolated,
  reuse,
} from "@seqlane/core";
import { openai } from "@seqlane/core/models";
import { z } from "zod";

const workflowInput = z.strictObject({
  traceDir: z.string().min(1),
});
const taskInput = z.strictObject({
  traceDir: z.string().min(1),
});
const agentOutput = z.strictObject({ value: z.string() });
const lineageOutput = z.strictObject({ value: z.string() });
const parallelOutput = z.strictObject({ left: z.string(), right: z.string() });

function agent(id: string) {
  return defineAgentTask({
    id,
    input: taskInput,
    output: agentOutput,
    goal: () => `Run generic fixture step ${id}`,
  });
}

const source = agent("effect-session-source");
const reuseSource = agent("effect-session-reuse-source");
const forkSource = agent("effect-session-fork-source");
const reuseFork = agent("effect-session-reuse-fork");

export const effectSessionLineageWorkflow = createFlow({
  id: "effect-v4-session-lineage-cli-fixture",
  input: workflowInput,
  output: lineageOutput,
})
  .task("source", source, ({ input }) => input, {
    session: isolated({ model: openai("gpt-5.6-luna") }),
  })
  .task("reuseSource", reuseSource, ({ input }) => input, {
    session: ({ tasks }) => reuse(tasks.source.session),
  })
  .task("forkSource", forkSource, ({ input }) => input, {
    session: ({ tasks }) => fork(tasks.source.session),
  })
  .task("reuseFork", reuseFork, ({ input }) => input, {
    session: ({ tasks }) => reuse(tasks.forkSource.session),
  })
  .output(({ tasks }) => tasks.reuseFork.output)
  .define();

const sharedSource = agent("effect-session-shared-source");
const sharedLeft = agent("effect-session-shared-left");
const sharedRight = agent("effect-session-shared-right");

export const effectSharedSessionWorkflow = createFlow({
  id: "effect-v4-shared-session-cli-fixture",
  input: workflowInput,
  output: parallelOutput,
})
  .task("source", sharedSource, ({ input }) => input, {
    session: isolated(),
  })
  .task("left", sharedLeft, ({ input }) => input, {
    session: ({ tasks }) => reuse(tasks.source.session),
  })
  .task("right", sharedRight, ({ input }) => input, {
    session: ({ tasks }) => reuse(tasks.source.session),
  })
  .output(({ tasks }) => ({
    left: tasks.left.output.value,
    right: tasks.right.output.value,
  }))
  .define();

const compatibleLeft = agent("effect-workspace-compatible-left");
const compatibleRight = agent("effect-workspace-compatible-right");

export const effectCompatibleWorkspaceWorkflow = createFlow({
  id: "effect-v4-compatible-workspace-cli-fixture",
  input: workflowInput,
  output: parallelOutput,
})
  .task("left", compatibleLeft, ({ input }) => input, {
    session: isolated(),
    workspace: "shared",
  })
  .task("right", compatibleRight, ({ input }) => input, {
    session: isolated(),
    workspace: "shared",
  })
  .output(({ tasks }) => ({
    left: tasks.left.output.value,
    right: tasks.right.output.value,
  }))
  .define();

const exclusive = agent("effect-workspace-exclusive");
const shared = agent("effect-workspace-shared");

export const effectConflictingWorkspaceWorkflow = createFlow({
  id: "effect-v4-conflicting-workspace-cli-fixture",
  input: workflowInput,
  output: parallelOutput,
})
  .task("exclusive", exclusive, ({ input }) => input, {
    session: isolated(),
    workspace: "exclusive",
  })
  .task("shared", shared, ({ input }) => input, {
    session: isolated(),
    workspace: "shared",
  })
  .output(({ tasks }) => ({
    left: tasks.exclusive.output.value,
    right: tasks.shared.output.value,
  }))
  .define();

const cancelExclusive = agent("effect-workspace-cancel-exclusive");
const cancelWaiter = agent("effect-workspace-cancel-waiter");

export const effectWorkspaceCancellationWorkflow = createFlow({
  id: "effect-v4-workspace-cancellation-cli-fixture",
  input: workflowInput,
  output: parallelOutput,
})
  .task("exclusive", cancelExclusive, ({ input }) => input, {
    session: isolated(),
    workspace: "exclusive",
  })
  .task("waiter", cancelWaiter, ({ input }) => input, {
    session: isolated(),
    workspace: "shared",
  })
  .output(({ tasks }) => ({
    left: tasks.exclusive.output.value,
    right: tasks.waiter.output.value,
  }))
  .define();
