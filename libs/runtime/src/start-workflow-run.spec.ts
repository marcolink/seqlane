// @test-scope ./start-workflow-run.ts
// @test-scope ./runtime/execution/effect-plan.ts
// @test-scope ./runtime/execution/settle-run-program.ts
import {
  buildWorkflow,
  createFlow,
  defineClassifierTask,
  defineAgentTask,
  defineTask,
  type SeqlaneEvent,
} from "@seqlane/core";
import type { AgentRuntime } from "@seqlane/agent-adapter";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { InvocationObservationEvent } from "@seqlane/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startWorkflowRun } from "./start-workflow-run.js";
import { createEffectPlanProgram } from "./runtime/execution/effect-plan.js";

const inputSchema = z.object({ value: z.string() });
const outputSchema = z.object({ value: z.string() });
const localTask = defineTask({
  id: "direct.local",
  input: inputSchema,
  output: outputSchema,
  execute: async ({ input: { value } }) => ({ value }),
});
const workflow = createFlow({
  id: "direct-runtime-test",
  input: inputSchema,
  output: outputSchema,
})
  .task("local", localTask, ({ input }) => ({ value: input.value }))
  .output(({ tasks }) => tasks.local.output)
  .define();

function createSink() {
  const events: SeqlaneEvent[] = [];
  return {
    events,
    sink: { emit: (event: SeqlaneEvent) => events.push(event) },
  };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }),
  );
});

describe("startWorkflowRun", () => {
  it("cancels before the target graph starts any task", async () => {
    let taskStarted = false;
    const task = defineTask({
      id: "direct.effect-early-cancel",
      input: inputSchema,
      output: outputSchema,
      execute: async ({ input }) => {
        taskStarted = true;
        return input;
      },
    });
    const built = buildWorkflow(
      createFlow({
        id: "direct-effect-early-cancel",
        input: inputSchema,
        output: outputSchema,
      })
        .task("task", task, ({ input }) => input)
        .output(({ tasks }) => tasks.task.output)
        .define(),
    );
    const handle = startWorkflowRun(
      {
        workflow: built,
        input: { value: "cancel" },
        events: { emit: () => undefined },
      },
      { program: createEffectPlanProgram },
    );

    await handle.cancel();
    await expect(handle.outcome).resolves.toEqual({ status: "cancelled" });
    expect(taskStarted).toBe(false);
  });

  it("waits for target task callback settlement before cancel resolves", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = defineTask({
      id: "direct.effect-cancel-cleanup",
      input: inputSchema,
      output: outputSchema,
      execute: async ({ input }) => {
        markStarted();
        await held;
        return input;
      },
    });
    const built = buildWorkflow(
      createFlow({
        id: "direct-effect-cancel-cleanup",
        input: inputSchema,
        output: outputSchema,
      })
        .task("task", task, ({ input }) => input)
        .output(({ tasks }) => tasks.task.output)
        .define(),
    );
    const handle = startWorkflowRun(
      {
        workflow: built,
        input: { value: "cancel" },
        events: { emit: () => undefined },
      },
      { program: createEffectPlanProgram },
    );
    await started;
    let cancelSettled = false;
    const cancellation = handle.cancel().then(() => {
      cancelSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancelSettled).toBe(false);

    release();
    await cancellation;
    await expect(handle.outcome).resolves.toEqual({ status: "cancelled" });
  });

  it("closes a prebootstrapped runtime before settling an already-cancelled run", async () => {
    let inputParses = 0;
    const guardedInput = z.preprocess((value) => {
      inputParses += 1;
      return value;
    }, z.string());
    const taskStarted = { value: false };
    const task = defineTask({
      id: "direct.effect-aborted-input",
      input: z.string(),
      output: z.string(),
      execute: async ({ input }) => {
        taskStarted.value = true;
        return input;
      },
    });
    const built = buildWorkflow(
      createFlow({
        id: "direct-effect-already-cancelled",
        input: guardedInput,
        output: z.string(),
      })
        .task("task", task, ({ input }) => input)
        .output(({ tasks }) => tasks.task.output)
        .define(),
    );
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const runtime: AgentRuntime = {
      identity: "prebootstrapped-fixture",
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: false,
        sessionReuse: false,
        checkpoint: false,
        fork: false,
        activity: false,
        sessionUi: false,
      },
      createAdapter: () => {
        throw new Error("The target graph does not create an adapter");
      },
      redactAdapter: (adapter) => adapter,
      close: async () => {
        markCloseStarted();
        await closeGate;
      },
    };
    const controller = new AbortController();
    controller.abort();
    const handle = startWorkflowRun(
      {
        workflow: built,
        input: 12,
        agentRuntime: runtime,
        events: { emit: () => undefined },
        signal: controller.signal,
      },
      { program: createEffectPlanProgram },
    );
    let outcomeSettled = false;
    const outcome = handle.outcome.then((result) => {
      outcomeSettled = true;
      return result;
    });
    const cancellation = handle.cancel();
    await closeStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcomeSettled).toBe(false);
    expect(inputParses).toBe(0);
    expect(taskStarted.value).toBe(false);

    releaseClose();
    await cancellation;
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(inputParses).toBe(0);
  });

  it("applies the workflow input transform once in the target program", async () => {
    let inputTransforms = 0;
    const transformedInputSchema = z
      .object({ value: z.string() })
      .transform(({ value }) => {
        inputTransforms += 1;
        return { value: `${value}!` };
      });
    const task = defineTask({
      id: "direct.effect-transform-once",
      input: inputSchema,
      output: outputSchema,
      execute: async ({ input }) => input,
    });
    const built = buildWorkflow(
      createFlow({
        id: "direct-effect-transform-once",
        input: transformedInputSchema,
        output: outputSchema,
      })
        .task("task", task, ({ input }) => input)
        .output(({ tasks }) => tasks.task.output)
        .define(),
    );
    const handle = startWorkflowRun(
      {
        workflow: built,
        input: { value: "once" },
        events: { emit: () => undefined },
      },
      { program: createEffectPlanProgram },
    );

    await expect(handle.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: { value: "once!" },
    });
    expect(inputTransforms).toBe(1);
  });

  it("rejects invalid workflow input before creating or starting task invocations", async () => {
    let taskStarted = false;
    const task = defineTask({
      id: "direct.effect-invalid-input",
      input: z.string(),
      output: z.string(),
      execute: async ({ input }) => {
        taskStarted = true;
        return input;
      },
    });
    const built = buildWorkflow(
      createFlow({
        id: "direct-effect-invalid-input",
        input: z.string(),
        output: z.string(),
      })
        .task("task", task, ({ input }) => input)
        .output(({ tasks }) => tasks.task.output)
        .define(),
    );
    const { events, sink } = createSink();
    const handle = startWorkflowRun(
      { workflow: built, input: 12, events: sink },
      { program: createEffectPlanProgram },
    );

    await expect(handle.outcome).resolves.toMatchObject({ status: "failed" });
    expect(taskStarted).toBe(false);
    expect(events.some((event) => event.type === "invocation.created")).toBe(
      false,
    );
    expect(events.some((event) => event.type === "invocation.started")).toBe(
      false,
    );
    expect(events.at(-1)?.type).toBe("run.failed");
  });

  it("starts a ready successor before a slow independent prerequisite and joins both", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    let slowFinished = false;
    let markSuccessorStarted!: () => void;
    const successorStarted = new Promise<void>((resolve) => {
      markSuccessorStarted = resolve;
    });
    let markJoinStarted!: () => void;
    const joinStarted = new Promise<void>((resolve) => {
      markJoinStarted = resolve;
    });
    let outputTransforms = 0;
    const slowTask = defineTask({
      id: "direct.effect-dag-slow",
      input: z.object({ value: z.string() }),
      output: z.object({ ready: z.boolean() }),
      execute: async () => {
        markSlowStarted();
        await slowGate;
        slowFinished = true;
        return { ready: true };
      },
    });
    const fastTask = defineTask({
      id: "direct.effect-dag-fast",
      input: z.object({ flag: z.boolean().default(false) }),
      output: z.object({ flag: z.boolean() }),
      execute: async ({ input }) => input,
    });
    const successorTask = defineTask({
      id: "direct.effect-dag-successor",
      input: z.object({ flag: z.boolean() }),
      output: z.object({ flag: z.boolean() }),
      execute: async ({ input }) => {
        markSuccessorStarted();
        return input;
      },
    });
    const joinTask = defineTask({
      id: "direct.effect-dag-join",
      input: z.object({ slowReady: z.boolean(), flag: z.boolean() }),
      output: z.object({ flag: z.boolean() }),
      execute: async ({ input }) => {
        markJoinStarted();
        return { flag: input.slowReady && input.flag };
      },
    });
    const built = buildWorkflow(
      createFlow({
        id: "direct-effect-dag-success",
        input: z.object({ value: z.string().default("defaulted") }),
        output: z.object({ flag: z.boolean() }).transform(({ flag }) => {
          outputTransforms += 1;
          return { flag, label: flag ? "enabled" : "disabled" };
        }),
      })
        .task("slow", slowTask, ({ input }) => ({ value: input.value }), {
          dependsOn: [],
          workspace: "shared",
        })
        .task("fast", fastTask, () => ({ flag: false }), {
          dependsOn: [],
          workspace: "shared",
        })
        .task(
          "successor",
          successorTask,
          ({ tasks }) => ({
            flag: tasks.fast.output.flag,
          }),
          { workspace: "shared" },
        )
        .task(
          "join",
          joinTask,
          ({ tasks }) => ({
            slowReady: tasks.slow.output.ready,
            flag: tasks.successor.output.flag,
          }),
          { workspace: "shared" },
        )
        .output(({ tasks }) => ({
          flag: tasks.join.output.flag,
          label: "raw value is replaced by transform",
        }))
        .define(),
    );
    const { events, sink } = createSink();
    const handle = startWorkflowRun(
      { workflow: built, input: {}, events: sink },
      { program: createEffectPlanProgram },
    );

    await Promise.race([
      Promise.all([slowStarted, successorStarted]),
      handle.outcome.then((result) => {
        throw new Error(
          `DAG settled before callbacks: ${JSON.stringify({ result, events })}`,
        );
      }),
    ]);
    expect(slowFinished).toBe(false);
    let outcomeSettled = false;
    const outcome = handle.outcome.then((value) => {
      outcomeSettled = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcomeSettled).toBe(false);
    releaseSlow();
    await joinStarted;
    await expect(outcome).resolves.toMatchObject({
      status: "succeeded",
      result: { flag: false, label: "disabled" },
    });
    expect(outputTransforms).toBe(1);

    const created = events.filter(
      (event) => event.type === "invocation.created",
    );
    const terminalEvents = events.filter(
      (event) =>
        event.type === "invocation.succeeded" ||
        event.type === "invocation.failed" ||
        event.type === "invocation.cancelled" ||
        event.type === "invocation.skipped",
    );
    expect(terminalEvents).toHaveLength(created.length);
    expect(events.at(-1)?.type).toBe("run.succeeded");
  });

  it("skips failed dependents and waits for independent started work to settle", async () => {
    let releaseIndependent!: () => void;
    const independentGate = new Promise<void>((resolve) => {
      releaseIndependent = resolve;
    });
    let markIndependentStarted!: () => void;
    const independentStarted = new Promise<void>((resolve) => {
      markIndependentStarted = resolve;
    });
    let dependentStarted = false;
    const failingTask = defineTask({
      id: "direct.effect-dag-failure",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      execute: async () => {
        throw new Error("expected prerequisite failure");
      },
    });
    const dependentTask = defineTask({
      id: "direct.effect-dag-dependent",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      execute: async ({ input }) => {
        dependentStarted = true;
        return input;
      },
    });
    const independentTask = defineTask({
      id: "direct.effect-dag-independent",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      execute: async ({ input }) => {
        markIndependentStarted();
        await independentGate;
        return input;
      },
    });
    const built = buildWorkflow(
      createFlow({
        id: "direct-effect-dag-failure",
        input: inputSchema,
        output: outputSchema,
      })
        .task("failure", failingTask, ({ input }) => input, {
          dependsOn: [],
          workspace: "shared",
        })
        .task(
          "dependent",
          dependentTask,
          ({ tasks }) => ({ value: tasks.failure.output.value }),
          { workspace: "shared" },
        )
        .task("independent", independentTask, ({ input }) => input, {
          dependsOn: [],
          workspace: "shared",
        })
        .output(({ tasks }) => tasks.independent.output)
        .define(),
    );
    const { events, sink } = createSink();
    const handle = startWorkflowRun(
      { workflow: built, input: { value: "failure" }, events: sink },
      { program: createEffectPlanProgram },
    );

    await Promise.race([
      independentStarted,
      handle.outcome.then((result) => {
        throw new Error(
          `DAG settled before independent task: ${JSON.stringify({ result, events })}`,
        );
      }),
    ]);
    let outcomeSettled = false;
    const outcome = handle.outcome.then((value) => {
      outcomeSettled = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcomeSettled).toBe(false);
    expect(dependentStarted).toBe(false);
    releaseIndependent();
    await expect(outcome).resolves.toMatchObject({ status: "failed" });

    const created = events.filter(
      (event) => event.type === "invocation.created",
    );
    const terminalEvents = events.filter(
      (event) =>
        event.type === "invocation.succeeded" ||
        event.type === "invocation.failed" ||
        event.type === "invocation.cancelled" ||
        event.type === "invocation.skipped",
    );
    expect(terminalEvents).toHaveLength(created.length);
    expect(
      terminalEvents.some((event) => event.type === "invocation.skipped"),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("run.failed");
  });

  it("runs mixed classifier questions from prior task output and reports one identified observation", async () => {
    const apiKey = "direct-classifier-private-key";
    const responseBody = {
      model: "jev-1.13.0",
      answers: {
        area: {
          type: "choice",
          choice: "runtime",
          probabilities: { runtime: 0.8, docs: 0.2 },
          confidence: 0.8,
        },
        priority: {
          type: "score",
          score: 0.8,
          legend: { "0": "Low", "1": "High" },
          probabilities: { "0": 0.2, "1": 0.8 },
          confidence: 0.8,
        },
        needsReview: { type: "noul", noul: 0.63 },
      },
      usage: { input_tokens: 14, output_tokens: 7 },
    };
    const requestData = {
      model: "jev-latest",
      state: { diff: "prepared:example diff" },
      questions: {
        area: {
          type: "choice",
          instructions: "Which area changed?",
          criteria: { runtime: "Runtime", docs: "Documentation" },
        },
        priority: {
          type: "score",
          instructions: "How urgent is review?",
          criteria: ["Low", "High"],
        },
        needsReview: {
          type: "noul",
          instructions: "Does this diff need review?",
        },
      },
    };
    const capturedRequests: string[] = [];
    let requestCount = 0;
    let capturedAuthorization: string | undefined;
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        requestCount += 1;
        capturedRequests.push(Buffer.concat(chunks).toString("utf8"));
        capturedAuthorization = incoming.headers.authorization;
        if (requestCount === 1) {
          outgoing.writeHead(429, { "retry-after": "0" });
          outgoing.end("busy");
          return;
        }
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(responseBody));
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Classifier fixture did not bind a TCP port");
    }

    const classifierInputSchema = z.object({ diff: z.string() });
    const preparedSchema = z.object({ diff: z.string() });
    const prepare = defineTask({
      id: "direct.prepare-classifier-input",
      input: classifierInputSchema,
      output: preparedSchema,
      execute: async ({ input }) => ({ diff: `prepared:${input.diff}` }),
    });
    const classifier = defineClassifierTask({
      id: "direct-classifier-mixed",
      input: preparedSchema,
      state: ({ diff }) => ({ diff }),
      questions: {
        area: {
          kind: "choice",
          instructions: "Which area changed?",
          criteria: { runtime: "Runtime", docs: "Documentation" },
        },
        priority: {
          kind: "score",
          instructions: "How urgent is review?",
          criteria: ["Low", "High"],
        },
        needsReview: {
          kind: "noul",
          instructions: "Does this diff need review?",
        },
      },
    });
    const classifierWorkflow = createFlow({
      id: "direct-classifier-workflow",
      input: classifierInputSchema,
      output: classifier.output,
    })
      .task("prepare", prepare, ({ input }) => input)
      .task("classify", classifier, ({ tasks }) => tasks.prepare.output)
      .output(({ tasks }) => tasks.classify.output)
      .define();
    const observations: Omit<InvocationObservationEvent, "metadata">[] = [];
    const handle = startWorkflowRun({
      workflow: buildWorkflow(classifierWorkflow),
      input: { diff: "example diff" },
      workspace: process.cwd(),
      classifierConnection: {
        url: `http://127.0.0.1:${address.port}/v1/systemone`,
        model: "jev-latest",
        apiKey,
      },
      identity: { workId: "work-classifier", runId: "run-classifier" },
      events: { emit: () => undefined },
      onObservation: (event) => observations.push(event),
    });

    await expect(handle.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: {
        answers: {
          area: {
            kind: "choice",
            selected: "runtime",
            probabilities: { runtime: 0.8, docs: 0.2 },
            confidence: 0.8,
          },
          priority: {
            kind: "score",
            value: 0.8,
            legend: { "0": "Low", "1": "High" },
            probabilities: { "0": 0.2, "1": 0.8 },
            confidence: 0.8,
          },
          needsReview: { kind: "noul", probability: 0.63 },
        },
      },
    });
    expect(capturedAuthorization).toBe(`Bearer ${apiKey}`);
    expect(capturedRequests).toEqual([
      JSON.stringify(requestData),
      JSON.stringify(requestData),
    ]);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      type: "invocation.observation",
      workId: "work-classifier",
      runId: "run-classifier",
      invocationId: expect.any(String),
      observationId: expect.any(String),
      kind: "model",
      state: "failed",
      attemptIndex: 0,
      model: {
        operation: "classifier",
        model: "jev-latest",
        request: requestData,
        error: expect.stringContaining("HTTP 429"),
      },
    });
    expect(observations[1]).toMatchObject({
      type: "invocation.observation",
      workId: "work-classifier",
      runId: "run-classifier",
      invocationId: observations[0]?.invocationId,
      observationId: observations[0]?.observationId,
      kind: "model",
      state: "succeeded",
      attemptIndex: 1,
      model: {
        operation: "classifier",
        model: "jev-1.13.0",
        request: requestData,
        response: responseBody,
        usage: responseBody.usage,
      },
    });
    expect(JSON.stringify(observations)).not.toContain(apiKey);
  });

  it("does not invoke downstream tasks when a Choice answer violates its criteria", async () => {
    const invalidResponse = {
      model: "jev-1.13.0",
      answers: {
        area: {
          type: "choice",
          choice: "billing",
          probabilities: { runtime: 0.8, docs: 0.2 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 10, output_tokens: 4 },
    };
    const server = createServer((_incoming, outgoing) => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(invalidResponse));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Classifier fixture did not bind a TCP port");
    }

    const classifierInputSchema = z.object({ diff: z.string() });
    const classifier = defineClassifierTask({
      id: "direct-classifier-invalid-choice",
      input: classifierInputSchema,
      state: ({ diff }) => diff,
      questions: {
        area: {
          kind: "choice",
          instructions: "Which area changed?",
          criteria: { runtime: "Runtime", docs: "Documentation" },
        },
      },
    });
    let downstreamCalls = 0;
    const downstream = defineTask({
      id: "direct-classifier-downstream",
      input: classifier.output,
      output: z.object({ consumed: z.boolean() }),
      execute: async () => {
        downstreamCalls += 1;
        return { consumed: true };
      },
    });
    const classifierWorkflow = createFlow({
      id: "direct-classifier-invalid-choice-workflow",
      input: classifierInputSchema,
      output: downstream.output,
    })
      .task("classify", classifier, ({ input }) => input)
      .task("downstream", downstream, ({ tasks }) => tasks.classify.output)
      .output(({ tasks }) => tasks.downstream.output)
      .define();
    const observations: unknown[] = [];
    const handle = startWorkflowRun({
      workflow: buildWorkflow(classifierWorkflow),
      input: { diff: "example diff" },
      workspace: process.cwd(),
      classifierConnection: {
        url: `http://127.0.0.1:${address.port}/v1/systemone`,
        model: "jev-latest",
      },
      identity: {
        workId: "work-classifier-invalid",
        runId: "run-classifier-invalid",
      },
      events: { emit: () => undefined },
      onObservation: (event) => observations.push(event),
    });

    const outcome = await handle.outcome;
    expect(outcome.status).toBe("failed");
    expect(downstreamCalls).toBe(0);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      type: "invocation.observation",
      kind: "model",
      state: "failed",
      model: {
        operation: "classifier",
        error: expect.stringContaining("response"),
      },
    });
  });

  it("accepts a pre-bootstrapped agent runtime without adapter configuration", async () => {
    const agentTask = defineAgentTask({
      id: "direct.agent",
      input: inputSchema,
      output: outputSchema,
      goal: () => "complete task",
    });
    const agentWorkflow = createFlow({
      id: "direct-agent-runtime",
      input: inputSchema,
      output: outputSchema,
    })
      .task("agent", agentTask, ({ input }) => input)
      .output(({ tasks }) => tasks.agent.output)
      .define();
    let adaptersCreated = 0;
    const agentRuntime: AgentRuntime = {
      identity: "fixture",
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: false,
        checkpoint: false,
        fork: false,
        activity: false,
        sessionUi: false,
      },
      createAdapter: () => {
        adaptersCreated += 1;
        return {
          capabilities: agentRuntime.capabilities,
          execute: async ({ onExecutionStarted }) => {
            onExecutionStarted();
            return { value: "complete" };
          },
        };
      },
      redactAdapter: (adapter) => adapter,
    };

    const handle = startWorkflowRun({
      workflow: buildWorkflow(agentWorkflow),
      input: { value: "input" },
      workspace: process.cwd(),
      agentRuntime,
      events: { emit: () => undefined },
    });

    await expect(handle.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: { value: "complete" },
    });
    expect(adaptersCreated).toBe(1);
  });

  it("declares no concrete adapter package in any dependency section", () => {
    const dependencySection = z.record(z.string(), z.string()).optional();
    const manifest = z
      .object({
        dependencies: dependencySection,
        devDependencies: dependencySection,
        optionalDependencies: dependencySection,
        peerDependencies: dependencySection,
      })
      .parse(
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ),
      );
    const declaredDependencies = Object.values(manifest).flatMap((section) =>
      Object.keys(section ?? {}),
    );
    const concreteAdapterDependencies = declaredDependencies.filter(
      (dependency) =>
        dependency.startsWith("@seqlane/") &&
        dependency.endsWith("-adapter") &&
        dependency !== "@seqlane/agent-adapter",
    );

    expect(concreteAdapterDependencies).toEqual([]);
  });

  it("validates workflow input before starting an agent runtime", async () => {
    const { sink: eventSink, events } = createSink();
    const handle = startWorkflowRun({
      workflow: buildWorkflow(workflow),
      input: null,
      workspace: process.cwd(),
      events: eventSink,
    });
    const outcome = await handle.outcome;
    expect(outcome.status).toBe("failed");
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "run.failed" });
  });

  it("closes a direct runtime when workflow input is invalid", async () => {
    let closed = 0;
    const agentRuntime: AgentRuntime = {
      identity: "fixture",
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: false,
        checkpoint: false,
        fork: false,
        activity: false,
        sessionUi: false,
      },
      createAdapter: () => {
        throw new Error("Invalid input must not create an adapter");
      },
      redactAdapter: (adapter) => adapter,
      close: async () => {
        closed += 1;
      },
    };

    const handle = startWorkflowRun({
      workflow: buildWorkflow(workflow),
      input: null,
      workspace: process.cwd(),
      agentRuntime,
      events: { emit: () => undefined },
    });

    await expect(handle.outcome).resolves.toMatchObject({
      status: "failed",
    });
    expect(closed).toBe(1);
  });

  it("rejects a direct runtime with standalone execution", async () => {
    const agentRuntime: AgentRuntime = {
      identity: "fixture",
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: false,
        checkpoint: false,
        fork: false,
        activity: false,
        sessionUi: false,
      },
      createAdapter: () => {
        throw new Error("Standalone execution must not create an adapter");
      },
      redactAdapter: (adapter) => adapter,
    };

    const handle = startWorkflowRun({
      workflow: buildWorkflow(workflow),
      input: { value: "valid" },
      workspace: process.cwd(),
      agentRuntime,
      standalone: { adapter: "test-fixture", workspace: process.cwd() },
      events: { emit: () => undefined },
    });

    await expect(handle.outcome).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        cause: expect.objectContaining({
          message:
            "Select standalone execution or a direct agent runtime, not both",
        }),
      }),
    });
  });

  it("supports caller identities and cancellation before task work", async () => {
    let executed = false;
    const cancellationWorkflow = createFlow({
      id: "cancel",
      input: inputSchema,
      output: outputSchema,
    })
      .task(
        "local",
        defineTask({
          ...localTask,
          execute: async ({ input: value }) => {
            executed = true;
            return value;
          },
        }),
        ({ input }) => ({ value: input.value }),
      )
      .output(({ tasks }) => tasks.local.output)
      .define();
    const { sink: eventSink, events } = createSink();
    const handle = startWorkflowRun({
      workflow: buildWorkflow(cancellationWorkflow),
      input: { value: "ok" },
      workspace: process.cwd(),
      events: eventSink,
      identity: { workId: "work-fixed", runId: "run-fixed" },
    });
    await handle.cancel();
    const outcome = await handle.outcome;
    expect(outcome).toEqual({ status: "cancelled" });
    expect(executed).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        type: "run.started",
        workId: "work-fixed",
        runId: "run-fixed",
      }),
      expect.objectContaining({
        type: "run.cancelled",
        workId: "work-fixed",
        runId: "run-fixed",
      }),
    ]);
  });

  it("executes deterministic nested workflows through the public runner", async () => {
    const childTask = defineTask({
      id: "direct.child-task",
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async ({ input }) => ({ result: input.value + 1 }),
    });
    const child = createFlow({
      id: "direct.child-workflow",
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.number() }),
    })
      .task("increment", childTask, ({ input }) => input)
      .output(({ tasks }) => tasks.increment.output)
      .define();
    const parent = createFlow({
      id: "direct.parent-workflow",
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.number() }),
    })
      .task("child", child, ({ input }) => input)
      .output(({ tasks }) => tasks.child.output)
      .define();
    const { sink: eventSink, events } = createSink();

    const handle = startWorkflowRun({
      workflow: buildWorkflow(parent),
      input: { value: 2 },
      workspace: process.cwd(),
      events: eventSink,
      identity: { workId: "direct-work", runId: "direct-run" },
    });

    await expect(handle.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: { result: 3 },
    });

    const created = events.filter(
      (event): event is Extract<SeqlaneEvent, { type: "invocation.created" }> =>
        event.type === "invocation.created",
    );
    const parentInvocation = created.find(
      (event) => event.kind === "workflow" && event.label === child.id,
    );
    if (parentInvocation === undefined) {
      throw new Error("Expected nested workflow invocation event");
    }
    expect(created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentInvocationId: parentInvocation.invocationId,
          kind: "task",
          label: childTask.id,
        }),
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      type: "run.succeeded",
      workId: "direct-work",
      runId: "direct-run",
      output: { result: 3 },
    });
  });

  it("preserves a typed failure when terminal event delivery keeps throwing", async () => {
    let eventCount = 0;
    const handle = startWorkflowRun({
      workflow: buildWorkflow(workflow),
      input: null,
      workspace: process.cwd(),
      events: {
        emit: () => {
          eventCount += 1;
          if (eventCount > 1) throw new Error("event sink unavailable");
        },
      },
    });

    const outcome = await handle.outcome;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.category).toBe("RuntimeError");
    expect(outcome.error.cause).toBeInstanceOf(Error);
    expect(outcome.error.cause).toBeInstanceOf(z.ZodError);
    expect((outcome.error.cause as z.ZodError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_type",
          path: [],
        }),
      ]),
    );
    expect((outcome.error.cause as Error).message).not.toContain(
      "event sink unavailable",
    );
  });
});
