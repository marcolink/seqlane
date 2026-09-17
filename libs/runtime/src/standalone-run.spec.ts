// @test-scope ./start-workflow-run.ts
// @test-scope ./runner/profile/standalone-profile.ts
// @test-scope ./runtime/mastra/mastra-execution.ts
import {
  buildWorkflow,
  createFlow,
  defineTask,
  isolated,
  reuse,
  branch,
  type ModelSelection,
  type SeqlaneEvent,
} from "@seqlane/core";
import type { AgentAdapter } from "@seqlane/agent-adapter";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { startWorkflowRun } from "./start-workflow-run.js";
import type { StandaloneRunOptions } from "./runner/profile/standalone-profile.js";

const selection: ModelSelection = {
  model: { provider: "test", model: "selected" },
};
const other: ModelSelection = { model: { provider: "test", model: "other" } };
const empty = z.object({});
const output = z.object({ value: z.string() });
const agentTask = defineTask({
  id: "custom-agent",
  input: empty,
  output,
  execute: async ({ context }) =>
    output.parse(await context.runAgent({ goal: "return a value" })),
});
const localTask = defineTask({
  id: "local",
  input: empty,
  output,
  execute: async () => ({ value: "local" }),
});

function harness() {
  const execute = vi.fn<AgentAdapter["execute"]>(async () => ({
    value: "agent",
  }));
  const close = vi.fn(async () => undefined);
  const closeService = vi.fn(async () => undefined);
  const createAdapter = vi.fn((): AgentAdapter => ({
    capabilities: {
      execute: true,
      modelSelection: true,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: true,
      fork: true,
      activity: false,
      sessionUi: false,
    },
    execute,
    close,
    captureCheckpoint: async () => ({ native: "checkpoint" }),
    fork: async () => createAdapter(),
  }));
  const resolveDefaultModel = vi.fn(async () => other);
  const listModels = vi.fn(async () => [selection.model, other.model]);
  const startAdapter = vi.fn<NonNullable<StandaloneRunOptions["startAdapter"]>>(
    async () => ({
      binding: {
        capabilities: createAdapter().capabilities,
        createAdapter,
        modelCapabilities: {
          executor: "test",
          listModels,
          resolveDefaultModel,
        },
      },
      close: closeService,
    }),
  );
  const events: SeqlaneEvent[] = [];
  const standalone: StandaloneRunOptions = {
    workspace: process.cwd(),
    adapter: "test",
    startAdapter,
  };
  return {
    execute,
    close,
    closeService,
    startAdapter,
    listModels,
    resolveDefaultModel,
    events,
    standalone,
    sink: {
      emit: (event: SeqlaneEvent) => {
        events.push(event);
      },
    },
  };
}

function simple(task = agentTask, model?: ModelSelection) {
  return buildWorkflow(
    createFlow({ id: "standalone", input: empty, output, model })
      .task("task", task, () => ({}))
      .output(({ tasks }) => tasks.task.output)
      .define(),
  );
}

describe("standalone direct execution", () => {
  it("runs deterministic session branches without adapter acquisition or a model", async () => {
    const h = harness();
    const workflow = buildWorkflow(
      createFlow({ id: "deterministic-sessions", input: empty, output })
        .task("source", localTask, () => ({}), { session: isolated() })
        .task("branch", localTask, () => ({}), {
          session: ({ tasks }) => branch(tasks.source.session),
        })
        .task("reuse", localTask, () => ({}), {
          session: ({ tasks }) => reuse(tasks.branch.session),
        })
        .output(({ tasks }) => tasks.reuse.output)
        .define(),
    );
    const result = await startWorkflowRun({
      workflow,
      input: {},
      standalone: h.standalone,
      events: h.sink,
    }).outcome;
    expect(result).toMatchObject({
      status: "succeeded",
      result: { value: "local" },
    });
    expect(h.startAdapter).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("uses the workflow model for a custom one-shot agent and closes before the terminal event", async () => {
    const h = harness();
    const result = await startWorkflowRun({
      workflow: simple(agentTask, selection),
      input: {},
      standalone: h.standalone,
      events: h.sink,
    }).outcome;
    expect(result.status).toBe("succeeded");
    expect(h.execute).toHaveBeenCalledWith(
      expect.objectContaining({ modelSelection: selection }),
    );
    expect(h.resolveDefaultModel).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.closeService).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)?.type).toBe("run.succeeded");
  });

  it("fails a missing model at demand, after earlier deterministic work, without starting a service", async () => {
    const h = harness();
    const completed = vi.fn(async () => ({ value: "done" }));
    const workflow = buildWorkflow(
      createFlow({ id: "late-demand", input: empty, output })
        .task(
          "local",
          defineTask({ ...localTask, execute: completed }),
          () => ({}),
        )
        .task("agent", agentTask, () => ({}), { dependsOn: ["local"] })
        .output(({ tasks }) => tasks.agent.output)
        .define(),
    );
    const result = await startWorkflowRun({
      workflow,
      input: {},
      standalone: h.standalone,
      events: h.sink,
    }).outcome;
    expect(result.status).toBe("failed");
    expect(completed).toHaveBeenCalledTimes(1);
    expect(h.startAdapter).not.toHaveBeenCalled();
  });

  it("requires an adapter only when the workflow requests an agent", async () => {
    const h = harness();
    const standalone = { workspace: process.cwd() };
    expect(
      (
        await startWorkflowRun({
          workflow: simple(localTask),
          input: {},
          standalone,
          events: h.sink,
        }).outcome
      ).status,
    ).toBe("succeeded");
    expect(
      (
        await startWorkflowRun({
          workflow: simple(agentTask, selection),
          input: {},
          standalone,
          events: h.sink,
        }).outcome
      ).status,
    ).toBe("failed");
  });

  it("rejects an unavailable model and closes the service without invoking an agent", async () => {
    const h = harness();
    h.listModels.mockResolvedValue([]);
    const result = await startWorkflowRun({
      workflow: simple(agentTask, selection),
      input: {},
      standalone: h.standalone,
      events: h.sink,
    }).outcome;
    expect(result.status).toBe("failed");
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.closeService).toHaveBeenCalledTimes(1);
  });

  it("inherits source selections through reuse and branches, including an explicit branch override", async () => {
    const h = harness();
    const workflow = buildWorkflow(
      createFlow({ id: "inheritance", input: empty, output, model: other })
        .task("source", agentTask, () => ({}), { session: isolated(selection) })
        .task("reuse", agentTask, () => ({}), {
          session: ({ tasks }) => reuse(tasks.source.session),
        })
        .task("branch", agentTask, () => ({}), {
          session: ({ tasks }) => branch(tasks.reuse.session),
        })
        .task("override", agentTask, () => ({}), {
          session: ({ tasks }) => branch(tasks.branch.session, other),
        })
        .output(({ tasks }) => tasks.override.output)
        .define(),
    );
    expect(
      (
        await startWorkflowRun({
          workflow,
          input: {},
          standalone: h.standalone,
          events: h.sink,
        }).outcome
      ).status,
    ).toBe("succeeded");
    expect(
      h.execute.mock.calls.map(([request]) => request.modelSelection),
    ).toEqual([selection, selection, selection, other]);
    expect(h.startAdapter).toHaveBeenCalledTimes(1);
  });

  it("transforms workflow input once and supplies the transformed value to tasks", async () => {
    const h = harness();
    const transform = vi.fn(({ value }: { value: string }) => ({
      value: value + "!",
    }));
    const task = defineTask({
      id: "echo",
      input: output,
      output,
      execute: async ({ input }) => input,
    });
    const workflow = buildWorkflow(
      createFlow({
        id: "transform",
        input: output.transform(transform),
        output,
      })
        .task("echo", task, ({ input }) => input)
        .output(({ tasks }) => tasks.echo.output)
        .define(),
    );
    expect(
      await startWorkflowRun({
        workflow,
        input: { value: "ok" },
        standalone: h.standalone,
        events: h.sink,
      }).outcome,
    ).toMatchObject({ status: "succeeded", result: { value: "ok!" } });
    expect(transform).toHaveBeenCalledTimes(1);
  });

  it("turns a cleanup failure into failure after otherwise successful work", async () => {
    const h = harness();
    h.closeService.mockRejectedValue(new Error("close failed"));
    const result = await startWorkflowRun({
      workflow: simple(agentTask, selection),
      input: {},
      standalone: h.standalone,
      events: h.sink,
    }).outcome;
    expect(result.status).toBe("failed");
    expect(h.events.at(-1)?.type).toBe("run.failed");
  });

  it("preserves the primary failure when cleanup also fails", async () => {
    const h = harness();
    h.execute.mockRejectedValue(new Error("primary failure"));
    h.closeService.mockRejectedValue(new Error("close failed"));
    const onDiagnostic = vi.fn();
    const result = await startWorkflowRun({
      workflow: simple(agentTask, selection),
      input: {},
      standalone: h.standalone,
      events: h.sink,
      onDiagnostic,
    }).outcome;
    expect(result.status).toBe("failed");
    if (result.status === "failed")
      expect(result.error.message).toContain("primary failure");
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("cleanup failed"),
    );
  });
});
