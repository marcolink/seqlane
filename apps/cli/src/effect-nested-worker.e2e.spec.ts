// @test-scope ./runner-client.ts
// @test-scope ./cli-contracts.ts
// @test-scope ./test-fixtures/effect-worker-test-support.ts
// @test-scope ./test-fixtures/effect-tracer-runner.ts
// @test-scope ./test-fixtures/effect-nested-workflow.ts
// @test-scope ./test-fixtures/effect-nested-cases.ts
// @test-scope ../../../libs/runtime/src/runner/effect-tracer.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/nested-workflow.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/effect-choice.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/effect-plan.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/program.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/settle-run-program.ts
// @test-scope ../../../libs/runtime/src/runtime/validation/output-validation-effect.ts
// @test-scope ../../../libs/runtime/src/runtime/invocation/joint-admission.ts
// @test-scope ../../../libs/runtime/src/runtime/workspace/workspace-lock.ts
// @test-scope ../../../libs/runtime/src/runner/main.ts
// @test-scope ../../../libs/runtime/src/runner/run.ts

import { once } from "node:events";
import { EventEmitter } from "node:events";
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
import {
  isRunRequest,
  type RunRequest,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import { z } from "zod";
import { runCommandResultSchema } from "./cli-contracts.js";
import { launchRunner } from "./runner-client.js";
import type { RunnerSignalSource } from "./runner-client.js";
import {
  closeRunnerWorker,
  prepareExternalCli,
} from "./test-fixtures/effect-worker-test-support.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliRoot = join(repositoryRoot, "apps/cli");
const compiledRunner = join(
  cliRoot,
  "dist/test-fixtures/effect-tracer-runner.js",
);
const workflowModule = join(
  cliRoot,
  "dist/test-fixtures/effect-nested-workflow.js",
);
const workflowUrl = pathToFileURL(workflowModule).href;
const casesModule = join(cliRoot, "dist/test-fixtures/effect-nested-cases.js");
const casesUrl = pathToFileURL(casesModule).href;
let temporaryRoot: string;
let consumerRoot: string;
let runnerPath: string;
let events: SeqlaneExecutionEvent[] = [];
type InvocationCreatedEvent = Extract<
  SeqlaneExecutionEvent,
  { readonly type: "invocation.created" }
>;

interface WorkflowTarget {
  readonly id: string;
  readonly moduleSpecifier: string;
  readonly exportName: string;
}

const baseWorkflow: WorkflowTarget = {
  id: "effect-v4-nested-parent-fixture",
  moduleSpecifier: workflowUrl,
  exportName: "effectNestedWorkflow",
};

const choiceWorkflow: WorkflowTarget = {
  id: "effect-v4-nested-choice-repeat-parent-fixture",
  moduleSpecifier: casesUrl,
  exportName: "effectNestedChoiceRepeatWorkflow",
};

const cancellationWorkflow: WorkflowTarget = {
  id: "effect-v4-nested-cancel-parent-fixture",
  moduleSpecifier: casesUrl,
  exportName: "effectNestedCancellationWorkflow",
};

function request(input: unknown, target: WorkflowTarget): RunRequest {
  const candidate: unknown = {
    type: "run.start",
    workflow: {
      id: target.id,
      moduleSpecifier: target.moduleSpecifier,
      exportName: target.exportName,
    },
    input,
    runtime: { id: "local" },
  };
  if (!isRunRequest(candidate)) {
    throw new TypeError(
      "Effect nested fixture input is not a valid run request",
    );
  }
  return candidate;
}

function startWorker(
  input: unknown,
  target: WorkflowTarget = baseWorkflow,
  signalSource: RunnerSignalSource | null = null,
) {
  events = [];
  return launchRunner(request(input, target), {
    runnerPath,
    cwd: consumerRoot,
    signalSource,
    onExecutionEvent: (event) => events.push(event),
  });
}

function terminalEvents(): SeqlaneExecutionEvent[] {
  return events.filter(
    (event) =>
      event.type === "run.succeeded" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled",
  );
}

function markerDirectory(prefix: string): string {
  return mkdtempSync(join(temporaryRoot, prefix));
}

async function stopCliChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), 3_000);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
  if (!exited) {
    child.kill("SIGKILL");
    await closed;
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fixture marker ${path}`);
}

function startCliWorkflow(
  target: WorkflowTarget,
  input: unknown,
): {
  readonly child: ChildProcess;
  readonly completed: Promise<{
    readonly code: number | null;
    readonly stderr: string;
    readonly result: z.output<typeof runCommandResultSchema>;
  }>;
} {
  const child = spawn(
    process.execPath,
    [
      join(consumerRoot, "bin/run.js"),
      "run",
      `${target.moduleSpecifier}#${target.exportName}`,
      "--input",
      JSON.stringify(input),
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
  const completed = once(child, "close").then(([code]) => ({
    code,
    stderr,
    result: runCommandResultSchema.parse(JSON.parse(stdout)),
  }));
  return { child, completed };
}

beforeAll(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-effect-nested-"));
  consumerRoot = prepareExternalCli({
    cliRoot,
    destination: join(temporaryRoot, "consumer"),
    runnerEntrypoint: "./dist/test-fixtures/effect-tracer-runner.js",
  });
  runnerPath = compiledRunner;
});

afterAll(() => {
  if (temporaryRoot !== undefined) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe("Effect nested workflow through the compiled CLI", () => {
  it("transforms child input once and preserves nested false-like output values", async () => {
    const traceDir = markerDirectory("nested-cli-");
    const input = { traceDir };
    const child = spawn(
      process.execPath,
      [
        join(consumerRoot, "bin/run.js"),
        "run",
        `${baseWorkflow.moduleSpecifier}#${baseWorkflow.exportName}`,
        "--input",
        JSON.stringify(input),
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
    try {
      const [code] = await once(child, "close");

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(runCommandResultSchema.parse(JSON.parse(stdout))).toMatchObject({
        status: "succeeded",
        output: {
          value: "normalized:child",
          defaults: { enabled: false, count: 0, label: "" },
        },
      });
      expect(readFileSync(join(traceDir, "child-input-parsed"), "utf8")).toBe(
        "parsed\n",
      );
      expect(readFileSync(join(traceDir, "parent-input-parsed"), "utf8")).toBe(
        "parsed\n",
      );
      expect(existsSync(join(consumerRoot, ".seqlane"))).toBe(false);
    } finally {
      await stopCliChild(child);
    }
  }, 30_000);

  it("emits one terminal event and identifies the child invocation by its parent", async () => {
    const traceDir = markerDirectory("nested-worker-");
    const client = startWorker({ traceDir });
    try {
      const result = await client.result;
      const created = events.filter(
        (event): event is InvocationCreatedEvent =>
          event.type === "invocation.created",
      );
      const parent = created.find(
        (event) =>
          event.subject.type === "workflow" &&
          event.subject.workflowId === "effect-v4-nested-child-fixture",
      );
      const childInvocation = created.find(
        (event) => event.taskId === "effect-nested-deterministic",
      );

      expect(result).toMatchObject({
        status: 0,
        terminalEvent: {
          type: "run.succeeded",
          output: {
            value: "normalized:child",
            defaults: { enabled: false, count: 0, label: "" },
          },
        },
      });
      expect(parent).toBeDefined();
      expect(childInvocation).toBeDefined();
      expect(parent?.invocationId).not.toBe(childInvocation?.invocationId);
      expect(parent?.subject).toEqual({
        type: "workflow",
        workflowId: "effect-v4-nested-child-fixture",
      });
      if (childInvocation?.type === "invocation.created") {
        expect(childInvocation.parentInvocationId).toBe(parent?.invocationId);
      }
      expect(terminalEvents()).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("run.succeeded");
      expect(readFileSync(join(traceDir, "child-input-parsed"), "utf8")).toBe(
        "parsed\n",
      );
      expect(readFileSync(join(traceDir, "parent-input-parsed"), "utf8")).toBe(
        "parsed\n",
      );
      expect(existsSync(join(consumerRoot, ".seqlane"))).toBe(false);
    } finally {
      await closeRunnerWorker(client);
    }
  });

  it("runs the selected nested choice with bounded repeat and output validation", async () => {
    const traceDir = markerDirectory("nested-choice-cli-");
    const invocation = startCliWorkflow(choiceWorkflow, {
      traceDir,
      selected: true,
      value: "valid",
      reject: false,
    });
    try {
      const { code, stderr, result } = await invocation.completed;

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(result).toMatchObject({
        status: "succeeded",
        output: { value: 4, accepted: true, source: "attempt" },
      });
      expect(readFileSync(join(traceDir, "repeat-attempts"), "utf8")).toBe(
        "1\n3\n",
      );
      expect(existsSync(join(traceDir, "unselected-started"))).toBe(false);
      expect(existsSync(join(consumerRoot, ".seqlane"))).toBe(false);
    } finally {
      await stopCliChild(invocation.child);
    }
  }, 30_000);

  it("keeps repeated attempt identities distinct within the selected child", async () => {
    const traceDir = markerDirectory("nested-repeat-events-");
    const client = startWorker(
      {
        traceDir,
        selected: true,
        value: "valid",
        reject: false,
      },
      choiceWorkflow,
    );
    try {
      const result = await client.result;
      const created = events.filter(
        (event): event is InvocationCreatedEvent =>
          event.type === "invocation.created",
      );
      const child = created.find(
        (event) =>
          event.subject.type === "workflow" &&
          event.subject.workflowId === "effect-v4-nested-repeat-child-fixture",
      );
      const repeat = created.find((event) => event.kind === "loop");
      const attempts = created.filter(
        (event) => event.taskId === "effect-nested-repeat-attempt",
      );

      expect(result).toMatchObject({
        status: 0,
        terminalEvent: {
          type: "run.succeeded",
          output: { value: 4, accepted: true, source: "attempt" },
        },
      });
      expect(child).toBeDefined();
      expect(repeat).toBeDefined();
      expect(repeat?.parentInvocationId).toBe(child?.invocationId);
      expect(attempts).toHaveLength(2);
      expect(new Set(attempts.map((event) => event.invocationId)).size).toBe(2);
      expect(attempts.map((event) => event.iteration)).toEqual([1, 2]);
      expect(
        attempts.every(
          (event) => event.parentInvocationId === repeat?.invocationId,
        ),
      ).toBe(true);
      expect(attempts[1]?.dependencyIds).toContain(attempts[0]?.invocationId);
      expect(terminalEvents()).toHaveLength(1);
    } finally {
      await closeRunnerWorker(client);
    }
  });

  it("fails the selected nested repeat when output validation rejects an attempt", async () => {
    const traceDir = markerDirectory("nested-validation-failure-");
    const client = startWorker(
      {
        traceDir,
        selected: true,
        value: "valid",
        reject: true,
      },
      choiceWorkflow,
    );
    try {
      const result = await client.result;

      expect(result).toMatchObject({
        status: 1,
        terminalEvent: {
          type: "run.failed",
          error: { category: "ValidationError" },
        },
      });
      expect(readFileSync(join(traceDir, "repeat-attempts"), "utf8")).toBe(
        "1\n",
      );
      expect(terminalEvents()).toHaveLength(1);
    } finally {
      await closeRunnerWorker(client);
    }
  });

  it("does not execute the selected nested arm when the choice selects the other arm", async () => {
    const traceDir = markerDirectory("nested-choice-unselected-");
    const client = startWorker(
      {
        traceDir,
        selected: false,
        value: "invalid",
        reject: false,
      },
      choiceWorkflow,
    );
    try {
      const result = await client.result;

      expect(result).toMatchObject({
        status: 0,
        terminalEvent: {
          type: "run.succeeded",
          output: { value: -1, accepted: true, source: "unselected" },
        },
      });
      expect(existsSync(join(traceDir, "unselected-started"))).toBe(true);
      expect(existsSync(join(traceDir, "repeat-attempts"))).toBe(false);
      const unselected = events.find(
        (event): event is InvocationCreatedEvent =>
          event.type === "invocation.created" &&
          event.subject.type === "workflow" &&
          event.subject.workflowId === "effect-v4-nested-repeat-child-fixture",
      );
      expect(unselected).toBeDefined();
      expect(
        events.some(
          (event) =>
            event.type === "invocation.input" &&
            event.invocationId === unselected?.invocationId,
        ),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === "invocation.started" &&
            event.invocationId === unselected?.invocationId,
        ),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === "invocation.started" &&
            event.taskId === "effect-nested-repeat-attempt",
        ),
      ).toBe(false);
      expect(terminalEvents()).toHaveLength(1);
    } finally {
      await closeRunnerWorker(client);
    }
  });

  it("validates selected child input before starting its invocation", async () => {
    const traceDir = markerDirectory("nested-choice-invalid-");
    const client = startWorker(
      {
        traceDir,
        selected: true,
        value: "invalid",
        reject: false,
      },
      choiceWorkflow,
    );
    try {
      const result = await client.result;
      const child = events.find(
        (event): event is InvocationCreatedEvent =>
          event.type === "invocation.created" &&
          event.subject.type === "workflow" &&
          event.subject.workflowId === "effect-v4-nested-repeat-child-fixture",
      );

      expect(result).toMatchObject({
        status: 1,
        terminalEvent: {
          type: "run.failed",
          error: { category: "InputValidationError" },
        },
      });
      expect(child).toBeDefined();
      expect(
        events.some(
          (event) =>
            event.type === "invocation.started" &&
            child !== undefined &&
            event.invocationId === child.invocationId,
        ),
      ).toBe(false);
      expect(existsSync(join(traceDir, "repeat-attempts"))).toBe(false);
      expect(terminalEvents()).toHaveLength(1);
    } finally {
      await closeRunnerWorker(client);
    }
  });

  it("finishes nested task cleanup before reporting run cancellation", async () => {
    const traceDir = markerDirectory("nested-cancel-");
    const signalSource = new EventEmitter() as EventEmitter &
      RunnerSignalSource;
    const client = startWorker(
      { traceDir, value: 1 },
      cancellationWorkflow,
      signalSource,
    );
    try {
      await waitForFile(join(traceDir, "cancel-started"));
      signalSource.emit("SIGINT");
      await waitForFile(join(traceDir, "cancel-cleanup-started"));
      expect(terminalEvents()).toHaveLength(0);
      writeFileSync(join(traceDir, "cancel-cleanup-release"), "release\n");
      const result = await client.result;

      expect(result).toMatchObject({
        status: 130,
        terminalEvent: { type: "run.cancelled" },
      });
      expect(readFileSync(join(traceDir, "cancel-cleaned"), "utf8")).toBe(
        "cleaned\n",
      );
      const cancelledTaskIndex = events.findIndex(
        (event) => event.type === "invocation.cancelled",
      );
      const terminalIndex = events.findIndex(
        (event) => event.type === "run.cancelled",
      );
      expect(cancelledTaskIndex).toBeGreaterThanOrEqual(0);
      expect(cancelledTaskIndex).toBeLessThan(terminalIndex);
      expect(terminalEvents()).toHaveLength(1);
    } finally {
      writeFileSync(join(traceDir, "cancel-cleanup-release"), "release\n");
      await closeRunnerWorker(client);
    }
  });
});
