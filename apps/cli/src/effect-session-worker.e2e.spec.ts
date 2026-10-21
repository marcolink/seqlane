// @test-scope ./commands/run.ts
// @test-scope ./run-execution.ts
// @test-scope ./runner-client.ts
// @test-scope ./cli-contracts.ts
// @test-scope ./test-fixtures/effect-session-runner.ts
// @test-scope ./test-fixtures/effect-session-workflows.ts
// @test-scope ../../../libs/runtime/src/runner/main.ts
// @test-scope ../../../libs/runtime/src/runner/run.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/effect-plan.ts
// @test-scope ../../../libs/runtime/src/runner/profile/runtime-profile.ts
// @test-scope ../../../libs/runtime/src/runtime/session/session-resolution.ts
// @test-scope ../../../libs/runtime/src/runtime/invocation/joint-admission.ts
// @test-scope ../../../libs/runtime/src/runtime/workspace/workspace-lock.ts

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isRunRequest,
  type RunRequest,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import { runCommandResultSchema } from "./cli-contracts.js";
import { launchRunner } from "./runner-client.js";
import {
  closeRunnerWorker,
  prepareExternalCli,
} from "./test-fixtures/effect-worker-test-support.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliRoot = join(repositoryRoot, "apps/cli");
const fixtureWorker = join(
  cliRoot,
  "dist/test-fixtures/effect-session-runner.js",
);
const workflowsModule = join(
  cliRoot,
  "dist/test-fixtures/effect-session-workflows.js",
);
const workflowsUrl = pathToFileURL(workflowsModule).href;
const traceEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("execute.started"),
    adapterId: z.string(),
    lineage: z.string(),
    taskId: z.string(),
    modelSelection: z.unknown().nullable(),
  }),
  z.strictObject({
    event: z.literal("execute.finished"),
    adapterId: z.string(),
    lineage: z.string(),
    taskId: z.string(),
    modelSelection: z.unknown().nullable(),
  }),
  z.strictObject({
    event: z.literal("checkpoint.captured"),
    sourceAdapterId: z.string(),
    lineage: z.string(),
  }),
  z.strictObject({
    event: z.literal("adapter.forked"),
    sourceAdapterId: z.string(),
    adapterId: z.string(),
    lineage: z.string(),
    modelSelection: z.unknown().nullable(),
  }),
  z.strictObject({ event: z.literal("adapter.close"), adapterId: z.string() }),
]);
type TraceEvent = z.output<typeof traceEventSchema>;

let temporaryRoot: string;
let consumerRoot: string;

interface CliResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly result?: z.output<typeof runCommandResultSchema>;
}

interface RunningCli {
  readonly child: ChildProcess;
  readonly completed: Promise<CliResult>;
}

function runCli(
  traceDir: string,
  exportName: string,
  gateExecution = false,
): RunningCli {
  if (gateExecution) writeFileSync(join(traceDir, "gate"), "gate");
  const input = JSON.stringify({ traceDir });
  const child = spawn(
    process.execPath,
    [
      join(consumerRoot, "bin/run.js"),
      "run",
      `${workflowsUrl}#${exportName}`,
      "--input",
      input,
      "--adapter",
      "codex",
      "--json",
    ],
    {
      cwd: consumerRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completed = new Promise<CliResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result =
        stdout.trim().length === 0
          ? undefined
          : runCommandResultSchema.parse(JSON.parse(stdout));
      resolve({ code, signal, stdout, stderr, ...(result ? { result } : {}) });
    });
  });
  return { child, completed };
}

function traceEvents(traceDir: string): TraceEvent[] {
  const path = join(traceDir, "trace.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => traceEventSchema.parse(JSON.parse(line)));
}

async function waitForTrace(
  traceDir: string,
  predicate: (events: readonly TraceEvent[]) => boolean,
): Promise<TraceEvent[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const events = traceEvents(traceDir);
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for a generic adapter trace in ${traceDir}: ${JSON.stringify(traceEvents(traceDir))}`,
  );
}

function waitForTraceOrCli(
  invocation: RunningCli,
  traceDir: string,
  predicate: (events: readonly TraceEvent[]) => boolean,
): Promise<TraceEvent[]> {
  return Promise.race([
    waitForTrace(traceDir, predicate),
    invocation.completed.then((result) => {
      const events = traceEvents(traceDir);
      if (predicate(events)) return events;
      throw new Error(
        `CLI completed before the expected fixture trace: ${JSON.stringify({ ...result, trace: events })}`,
      );
    }),
  ]);
}

function traceDirectory(prefix: string): string {
  return mkdtempSync(join(temporaryRoot, prefix));
}

function lineageRequest(traceDir: string): RunRequest {
  const candidate: unknown = {
    type: "run.start",
    workflow: {
      id: "effect-v4-session-lineage-cli-fixture",
      moduleSpecifier: workflowsUrl,
      exportName: "effectSessionLineageWorkflow",
    },
    input: { traceDir },
    runtime: { id: "direct-runtime" },
  };
  if (!isRunRequest(candidate)) {
    throw new TypeError("Session lineage fixture request is invalid");
  }
  return candidate;
}

beforeAll(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-effect-session-"));
  consumerRoot = prepareExternalCli({
    cliRoot,
    destination: join(temporaryRoot, "consumer"),
    runnerEntrypoint: "./dist/test-fixtures/effect-session-runner.js",
  });
  expect(existsSync(fixtureWorker)).toBe(true);
});

afterAll(() => {
  if (temporaryRoot !== undefined) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe("Effect session and workspace admission through the compiled CLI", () => {
  it("preserves the full canonical observation event and closes before the terminal", async () => {
    const traceDir = traceDirectory("observation-");
    const events: SeqlaneExecutionEvent[] = [];
    let traceAtTerminal: TraceEvent[] | undefined;
    const client = launchRunner(lineageRequest(traceDir), {
      runnerPath: fixtureWorker,
      cwd: repositoryRoot,
      onExecutionEvent: (event) => {
        events.push(event);
        if (
          event.type === "run.succeeded" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled"
        ) {
          traceAtTerminal = traceEvents(traceDir);
        }
      },
    });
    try {
      const result = await client.result;

      expect(result.status).toBe(0);
      expect(events.map((event) => event.metadata.sequence)).toEqual(
        events.map((_, index) => index + 1),
      );
      const terminals = events.filter(
        (event) =>
          event.type === "run.succeeded" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled",
      );
      expect(terminals).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("run.succeeded");
      const observation = events.find(
        (event) => event.type === "invocation.observation",
      );
      expect(observation?.type).toBe("invocation.observation");
      if (observation?.type !== "invocation.observation") {
        throw new Error("Expected the generic adapter's canonical observation");
      }
      const payload = Object.fromEntries(
        Object.entries(observation).filter(([key]) => key !== "metadata"),
      );
      expect(payload).toEqual({
        type: "invocation.observation",
        workId: observation.workId,
        runId: observation.runId,
        invocationId: observation.invocationId,
        observationId: `generic-fixture:${observation.invocationId}`,
        kind: "model",
        state: "succeeded",
        model: {
          operation: "generate",
          provider: "fixture",
          model: "generic-model",
          request: {
            options: { enabled: false, limit: 0, labels: [""] },
            messages: [{ role: "user", content: "" }],
          },
          response: {
            id: "fixture-response",
            accepted: false,
            text: "",
          },
          usage: { inputTokens: 0, outputTokens: 0, details: { note: "" } },
        },
      });
      expect(traceAtTerminal).toBeDefined();
      expect(
        traceAtTerminal?.some((event) => event.event === "adapter.close"),
      ).toBe(true);
    } finally {
      await closeRunnerWorker(client);
    }
  }, 30_000);

  it("preserves isolated, reused, checkpoint, fork, and model inheritance", async () => {
    const traceDir = traceDirectory("lineage-");
    const invocation = runCli(traceDir, "effectSessionLineageWorkflow");
    const result = await invocation.completed;
    const events = traceEvents(traceDir);

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.result).toMatchObject({
      status: "succeeded",
      output: { value: "effect-session-reuse-fork" },
    });
    expect(existsSync(join(consumerRoot, ".seqlane"))).toBe(false);

    const executions = events.filter(
      (event) => event.event === "execute.started",
    );
    expect(executions).toHaveLength(4);
    if (executions.some((event) => event.event !== "execute.started")) {
      throw new Error("Expected four start records");
    }
    const byTask = new Map(executions.map((event) => [event.taskId, event]));
    const source = byTask.get("effect-session-source");
    const reused = byTask.get("effect-session-reuse-source");
    const forked = byTask.get("effect-session-fork-source");
    const forkReused = byTask.get("effect-session-reuse-fork");
    expect(source).toBeDefined();
    expect(reused).toBeDefined();
    expect(forked).toBeDefined();
    expect(forkReused).toBeDefined();
    if (
      source === undefined ||
      reused === undefined ||
      forked === undefined ||
      forkReused === undefined
    ) {
      throw new Error("Expected all session lineage records");
    }
    expect(reused.adapterId).toBe(source.adapterId);
    expect(forked.adapterId).not.toBe(source.adapterId);
    expect(forkReused.adapterId).toBe(forked.adapterId);
    expect(reused.lineage).toBe(source.lineage);
    expect(forked.lineage).toBe(source.lineage);
    expect(forkReused.lineage).toBe(source.lineage);
    const selection = z
      .strictObject({
        model: z.strictObject({ provider: z.string(), model: z.string() }),
        reasoning: z.string().optional(),
      })
      .parse(source.modelSelection);
    expect(selection.model).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(reused.modelSelection).toEqual(source.modelSelection);
    expect(forked.modelSelection).toEqual(source.modelSelection);
    expect(forkReused.modelSelection).toEqual(source.modelSelection);
    expect(
      events.filter((event) => event.event === "checkpoint.captured"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.event === "adapter.forked"),
    ).toHaveLength(1);
    expect(
      events
        .filter((event) => event.event === "adapter.close")
        .map((event) => event.adapterId),
    ).toEqual(expect.arrayContaining([source.adapterId, forked.adapterId]));
  }, 30_000);

  it("serializes two callers that reuse one adapter session", async () => {
    const traceDir = traceDirectory("shared-session-");
    const invocation = runCli(traceDir, "effectSharedSessionWorkflow", true);
    try {
      const first = await waitForTraceOrCli(
        invocation,
        traceDir,
        (events) =>
          events.some(
            (event) =>
              event.event === "execute.started" &&
              event.taskId === "effect-session-shared-left",
          ) ||
          events.some(
            (event) =>
              event.event === "execute.started" &&
              event.taskId === "effect-session-shared-right",
          ),
      );
      const started = first.filter(
        (event) =>
          event.event === "execute.started" &&
          (event.taskId === "effect-session-shared-left" ||
            event.taskId === "effect-session-shared-right"),
      );
      expect(started).toHaveLength(1);
      writeFileSync(join(traceDir, "release"), "release");
      const result = await invocation.completed;
      expect(result.code).toBe(0);
      expect(result.result).toMatchObject({ status: "succeeded" });
      const events = traceEvents(traceDir);
      const leftStart = events.findIndex(
        (event) =>
          event.event === "execute.started" &&
          event.taskId === "effect-session-shared-left",
      );
      const rightStart = events.findIndex(
        (event) =>
          event.event === "execute.started" &&
          event.taskId === "effect-session-shared-right",
      );
      const leftFinish = events.findIndex(
        (event) =>
          event.event === "execute.finished" &&
          event.taskId === "effect-session-shared-left",
      );
      const rightFinish = events.findIndex(
        (event) =>
          event.event === "execute.finished" &&
          event.taskId === "effect-session-shared-right",
      );
      expect(Math.max(leftStart, rightStart)).toBeGreaterThan(
        Math.min(leftFinish, rightFinish),
      );
    } finally {
      writeFileSync(join(traceDir, "release"), "release");
    }
  }, 30_000);

  it("overlaps compatible work and queues a shared user behind an exclusive workspace lease", async () => {
    const compatibleTrace = traceDirectory("workspace-shared-");
    const compatible = runCli(
      compatibleTrace,
      "effectCompatibleWorkspaceWorkflow",
      true,
    );
    try {
      await waitForTraceOrCli(compatible, compatibleTrace, (events) =>
        [
          "effect-workspace-compatible-left",
          "effect-workspace-compatible-right",
        ].every((taskId) =>
          events.some(
            (event) =>
              event.event === "execute.started" && event.taskId === taskId,
          ),
        ),
      );
      writeFileSync(join(compatibleTrace, "release"), "release");
      expect((await compatible.completed).code).toBe(0);
    } finally {
      writeFileSync(join(compatibleTrace, "release"), "release");
    }

    const conflictTrace = traceDirectory("workspace-exclusive-");
    const conflict = runCli(
      conflictTrace,
      "effectConflictingWorkspaceWorkflow",
      true,
    );
    try {
      const exclusive = await waitForTraceOrCli(
        conflict,
        conflictTrace,
        (events) =>
          events.some(
            (event) =>
              event.event === "execute.started" &&
              event.taskId === "effect-workspace-exclusive",
          ),
      );
      expect(
        exclusive.some(
          (event) =>
            event.event === "execute.started" &&
            event.taskId === "effect-workspace-shared",
        ),
      ).toBe(false);
      writeFileSync(join(conflictTrace, "release"), "release");
      await waitForTraceOrCli(conflict, conflictTrace, (events) =>
        events.some(
          (event) =>
            event.event === "execute.started" &&
            event.taskId === "effect-workspace-shared",
        ),
      );
      writeFileSync(join(conflictTrace, "release"), "release");
      expect((await conflict.completed).code).toBe(0);
      const events = traceEvents(conflictTrace);
      const exclusiveFinish = events.findIndex(
        (event) =>
          event.event === "execute.finished" &&
          event.taskId === "effect-workspace-exclusive",
      );
      const sharedStart = events.findIndex(
        (event) =>
          event.event === "execute.started" &&
          event.taskId === "effect-workspace-shared",
      );
      expect(exclusiveFinish).toBeGreaterThanOrEqual(0);
      expect(sharedStart).toBeGreaterThan(exclusiveFinish);
    } finally {
      writeFileSync(join(conflictTrace, "release"), "release");
    }
  }, 45_000);

  it("cancels a workspace waiter and closes the active adapter before the CLI result", async () => {
    const traceDir = traceDirectory("workspace-cancel-");
    const invocation = runCli(
      traceDir,
      "effectWorkspaceCancellationWorkflow",
      true,
    );
    try {
      const events = await waitForTraceOrCli(invocation, traceDir, (trace) =>
        trace.some(
          (event) =>
            event.event === "execute.started" &&
            event.taskId === "effect-workspace-cancel-exclusive",
        ),
      );
      expect(
        events.some(
          (event) =>
            event.event === "execute.started" &&
            event.taskId === "effect-workspace-cancel-waiter",
        ),
      ).toBe(false);
      invocation.child.kill("SIGINT");
      const result = await invocation.completed;
      expect(result.code).toBe(130);
      expect(result.result).toMatchObject({ status: "cancelled" });
      const finalEvents = traceEvents(traceDir);
      expect(
        finalEvents.some(
          (event) =>
            event.event === "execute.started" &&
            event.taskId === "effect-workspace-cancel-waiter",
        ),
      ).toBe(false);
      const activeExecutions = finalEvents.filter(
        (event) =>
          event.event === "execute.started" &&
          event.taskId === "effect-workspace-cancel-exclusive",
      );
      expect(activeExecutions).toHaveLength(1);
      const activeExecution = activeExecutions[0];
      if (activeExecution?.event !== "execute.started") {
        throw new Error("Expected the exclusive execution trace");
      }
      const adapterId = activeExecution.adapterId;
      expect(
        finalEvents.some(
          (event) =>
            event.event === "adapter.close" && event.adapterId === adapterId,
        ),
      ).toBe(true);
    } finally {
      writeFileSync(join(traceDir, "release"), "release");
    }
  }, 30_000);
});
