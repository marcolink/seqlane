// @test-scope ./adapter.ts
// @test-scope ./stream.ts
// @test-scope ./transport.ts

import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { InteractionRequiredError } from "@seqlane/core";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import type { AgentTaskRequest, TaskDefinition } from "@seqlane/core";
import { createAcpAdapter } from "./adapter.js";
import { createAcpTransport } from "./transport.js";

const fixture = fileURLToPath(
  new URL("./controlled-acp-agent.mjs", import.meta.url),
);
const resultSchema = z.object({
  value: z.string(),
  cwd: z.string(),
  model: z.string(),
  argument: z.string(),
  promptCount: z.number(),
  processPromptCount: z.number(),
  processId: z.number(),
});
const peerPidMarkerSchema = z.string().regex(/^peer-pid:\d+$/);
const processIdSchema = z.number().int().positive();
const task: TaskDefinition = {
  id: "controlled-acp-task",
  input: z.string(),
  output: resultSchema,
  execute: async () => ({
    value: "done",
    cwd: "",
    model: "",
    argument: "",
    promptCount: 0,
    processPromptCount: 0,
    processId: 0,
  }),
};
const agent: AgentTaskRequest = { goal: "Complete the controlled input" };
const directories: string[] = [];
const adapters: ReturnType<typeof createAcpAdapter>[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "seqlane-acp-"));
  directories.push(path);
  return path;
}

function makeAdapter(
  configurationValue: ReturnType<typeof configuration>,
  options: Parameters<typeof createAcpAdapter>[1] = {},
) {
  const adapter = createAcpAdapter(configurationValue, options);
  adapters.push(adapter);
  return adapter;
}

async function closeAdapter(
  adapter: ReturnType<typeof createAcpAdapter>,
): Promise<void> {
  await adapter.close?.();
}

afterEach(async () => {
  await Promise.all(
    adapters
      .splice(0)
      .map((adapter) => closeAdapter(adapter).catch(() => undefined)),
  );
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function configuration(
  cwd: string,
  mode: string,
  persistSession = false,
  exitFile?: string,
  promptFile?: string,
  eventFile?: string,
) {
  return {
    id: "controlled-acp",
    description: "Official SDK ACP v1 fixture",
    command: process.execPath,
    args: [fixture, "configured-argument"],
    env: {
      CONTROLLED_ACP_MODE: mode,
      ...(exitFile === undefined ? {} : { CONTROLLED_ACP_EXIT_FILE: exitFile }),
      ...(promptFile === undefined
        ? {}
        : { CONTROLLED_ACP_PROMPT_FILE: promptFile }),
      ...(eventFile === undefined
        ? {}
        : { CONTROLLED_ACP_EVENT_FILE: eventFile }),
    },
    cwd,
    persistSession,
    model: "controlled-model",
  };
}

function request(
  signal = new AbortController().signal,
  overrides: Partial<AgentAdapterRequest> = {},
) {
  return {
    invocationId: "controlled-acp-invocation",
    task,
    input: "controlled input",
    agent,
    signal,
    onExecutionStarted: () => undefined,
    ...overrides,
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline)
      throw new Error(`ACP fixture did not create ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  }
}

async function waitForMarker(path: string, marker: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (
    !existsSync(path) ||
    !readFileSync(path, "utf8").includes(`${marker}\n`)
  ) {
    if (Date.now() >= deadline)
      throw new Error(`ACP fixture did not report ${marker}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  }
}

function containsCause(value: unknown, expected: unknown): boolean {
  if (value === expected) return true;
  if (value instanceof AggregateError)
    return [...value.errors].some((item) => containsCause(item, expected));
  if (value instanceof Error && Object.hasOwn(value, "cause"))
    return containsCause(value.cause, expected);
  return false;
}

function containsCauseMessage(value: unknown, message: string): boolean {
  if (value instanceof Error && value.message === message) return true;
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null &&
    "details" in value.data &&
    value.data.details === message
  )
    return true;
  if (value instanceof AggregateError)
    return [...value.errors].some((item) =>
      containsCauseMessage(item, message),
    );
  if (value instanceof Error) return containsCauseMessage(value.cause, message);
  return false;
}

function peerProcessId(eventFile: string): number {
  const marker = readFileSync(eventFile, "utf8")
    .split("\n")
    .find((line) => line.startsWith("peer-pid:"));
  const parsedMarker = peerPidMarkerSchema.parse(marker);
  return processIdSchema.parse(Number(parsedMarker.slice("peer-pid:".length)));
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
      return false;
    throw cause;
  }
}

describe("official SDK ACP v1 subprocess boundary", () => {
  it("closes the acquired process scope when ownership registration fails", async () => {
    const cwd = temporaryDirectory();
    const registrationError = new Error("process registration failed");
    let acquiredProcessId: number | undefined;

    await expect(
      createAcpTransport(
        configuration(cwd, "success"),
        undefined,
        async (pid) => {
          acquiredProcessId = pid;
          throw registrationError;
        },
      ),
    ).rejects.toBe(registrationError);
    if (acquiredProcessId === undefined)
      throw new Error("ACP process ownership callback was not called");
    expect(isProcessRunning(acquiredProcessId)).toBe(false);
  });

  it("launches configured stdio, selects the advertised model, and preserves native events", async () => {
    const cwd = temporaryDirectory();
    const exitFile = join(cwd, "exit");
    const activities: unknown[] = [];
    const observations: unknown[] = [];
    const adapter = makeAdapter(configuration(cwd, "success", false, exitFile));
    const result = resultSchema.parse(
      await adapter.execute(
        request(undefined, {
          onActivity: (activity) => activities.push(activity),
          onObservation: (observation) => observations.push(observation),
        }),
      ),
    );
    expect(result).toMatchObject({
      value: "done",
      cwd,
      model: "controlled-model",
      argument: "configured-argument",
      promptCount: 1,
      processPromptCount: 1,
    });
    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({
      activityId: "controlled-tool",
      state: "started",
      input: { path: "AGENTS.md" },
    });
    expect(activities[1]).toMatchObject({
      activityId: "controlled-tool",
      state: "succeeded",
      input: { path: "AGENTS.md" },
      output: { ok: true },
      metadata: { snapshot: { locations: [{ path: "/workspace/AGENTS.md" }] } },
    });
    expect(observations[0]).toMatchObject({
      model: {
        operation: "acp.session.usage",
        usage: {
          sessionId: "session-1",
          _meta: { traceId: "usage-notification" },
          update: {
            used: 42,
            size: 4096,
            cost: { amount: 0.25, currency: "USD" },
          },
        },
      },
    });
    await closeAdapter(adapter);
    await waitForFile(exitFile);
    expect(readFileSync(exitFile, "utf8")).toBe(`${result.processId}\n`);
  });

  it("creates separate sessions when persistence is disabled and reuses the session when enabled", async () => {
    const cwd = temporaryDirectory();
    const transient = makeAdapter(configuration(cwd, "success"));
    await expect(transient.execute(request())).resolves.toMatchObject({
      promptCount: 1,
    });
    await expect(transient.execute(request())).resolves.toMatchObject({
      promptCount: 1,
    });
    await closeAdapter(transient);

    const persistent = makeAdapter(configuration(cwd, "success", true));
    await expect(persistent.execute(request())).resolves.toMatchObject({
      promptCount: 1,
    });
    await expect(persistent.execute(request())).resolves.toMatchObject({
      promptCount: 2,
    });
    await closeAdapter(persistent);
  });

  it("rejects an unavailable or unconfirmed configured model before sending a prompt", async () => {
    const cwd = temporaryDirectory();
    const promptFile = join(cwd, "prompts");
    const missing = makeAdapter(
      configuration(cwd, "model-missing", false, undefined, promptFile),
    );
    await expect(missing.execute(request())).rejects.toMatchObject({
      code: "configuration",
    });
    await closeAdapter(missing);

    const mismatch = makeAdapter(
      configuration(cwd, "model-mismatch", false, undefined, promptFile),
    );
    await expect(mismatch.execute(request())).rejects.toMatchObject({
      code: "configuration",
    });
    await closeAdapter(mismatch);
    expect(existsSync(promptFile)).toBe(false);
  });

  it("repairs invalid structured output using the configured retry count", async () => {
    const cwd = temporaryDirectory();
    const adapter = makeAdapter(configuration(cwd, "repair"), {
      structuredOutputRetryCount: 1,
    });
    await expect(adapter.execute(request())).resolves.toMatchObject({
      value: "done",
      processPromptCount: 2,
    });
    await closeAdapter(adapter);
  });

  it("turns denied permission into an interaction error and cancels an active prompt", async () => {
    const permission = makeAdapter(
      configuration(temporaryDirectory(), "permission"),
    );
    await expect(permission.execute(request())).rejects.toBeInstanceOf(
      InteractionRequiredError,
    );
    await closeAdapter(permission);

    const cwd = temporaryDirectory();
    const controller = new AbortController();
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancellation = makeAdapter(configuration(cwd, "cancel"));
    const execution = cancellation.execute(
      request(controller.signal, {
        onActivity: () => started(),
      }),
    );
    await start;
    controller.abort(new Error("test cancellation"));
    await expect(execution).rejects.toMatchObject({ code: "cancellation" });
    await closeAdapter(cancellation);
  });

  it("accepts a void cancel acknowledgement and retains a late prompt RPC rejection after peer termination", async () => {
    const cwd = temporaryDirectory();
    const eventFile = join(cwd, "events");
    const exitFile = join(cwd, "exits");
    const adapter = makeAdapter(
      configuration(
        cwd,
        "cancel-reject",
        false,
        exitFile,
        undefined,
        eventFile,
      ),
    );
    const controller = new AbortController();
    const uncertainActivities: Array<{
      readonly reason: string;
      readonly termination?: Promise<unknown>;
    }> = [];
    let terminationConfirmed = false;
    let peerWasDeadAtFailure = false;
    let terminationWasConfirmedAtFailure = false;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execution = adapter.execute(
      request(controller.signal, {
        onActivity: (activity) => {
          if (activity.state === "started") {
            started();
            return;
          }
          if (activity.state === "failed") {
            const processId = peerProcessId(eventFile);
            peerWasDeadAtFailure = !isProcessRunning(processId);
            terminationWasConfirmedAtFailure = terminationConfirmed;
          }
        },
        onUncertainActivity: (activity) => {
          uncertainActivities.push(activity);
          if (activity.termination !== undefined) {
            void activity.termination.then(() => {
              terminationConfirmed = true;
            });
          }
        },
      }),
    );
    await start;
    const reason = Object.freeze(new Error("frozen abort reason"));
    controller.abort(reason);
    const failure = await execution.catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: "cancellation" });
    expect(containsCause(failure, reason)).toBe(true);
    expect(containsCauseMessage(failure, "late ACP prompt RPC failure")).toBe(
      true,
    );
    expect(containsCauseMessage(failure, "timed out")).toBe(false);
    expect(readFileSync(eventFile, "utf8")).toContain("cancel\n");
    expect(uncertainActivities.map(({ reason }) => reason)).toEqual([
      "disconnect",
    ]);
    expect(
      uncertainActivities.every(({ termination }) => termination !== undefined),
    ).toBe(true);
    expect(terminationWasConfirmedAtFailure).toBe(true);
    expect(peerWasDeadAtFailure).toBe(true);
    await closeAdapter(adapter);
    await waitForFile(exitFile);
    expect(readFileSync(exitFile, "utf8")).toContain(
      `${peerProcessId(eventFile)}\n`,
    );
  });

  it.each([
    null,
    0,
    "primitive abort",
    Object.freeze(new Error("frozen abort")),
  ])(
    "types pre-aborted requests and preserves the exact abort reason (%s)",
    async (reason) => {
      const cwd = temporaryDirectory();
      const exitFile = join(cwd, "exits");
      const adapter = makeAdapter(
        configuration(cwd, "success", false, exitFile),
      );
      const controller = new AbortController();
      controller.abort(reason);
      const failure = await adapter
        .execute(request(controller.signal))
        .catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ code: "cancellation" });
      expect(containsCause(failure, reason)).toBe(true);
      expect(existsSync(exitFile)).toBe(false);
      await closeAdapter(adapter);
    },
  );

  it("retains an undefined terminal observer failure while stopping the prompt", async () => {
    const cwd = temporaryDirectory();
    const eventFile = join(cwd, "events");
    const adapter = makeAdapter(
      configuration(cwd, "cancel", false, undefined, undefined, eventFile),
    );
    const execution = adapter.execute(
      request(undefined, {
        onActivity: (activity) => {
          if (activity.state === "started") throw undefined;
        },
      }),
    );
    const outcome = execution.catch((cause: unknown) => cause);
    await waitForMarker(eventFile, "cancel");
    const failure = await outcome;
    expect(failure).toMatchObject({ code: "execution" });
    expect(failure).toHaveProperty("cause");
    await closeAdapter(adapter);
  });

  it("rejects malformed native notifications before the SDK can discard them", async () => {
    const adapter = makeAdapter(
      configuration(temporaryDirectory(), "malformed-notification"),
    );
    await expect(adapter.execute(request())).rejects.toMatchObject({
      code: "malformed-stream",
    });
    await closeAdapter(adapter);
  });

  it("rejects an aborted request queued behind the adapter semaphore", async () => {
    const cwd = temporaryDirectory();
    const adapter = makeAdapter(configuration(cwd, "cancel", true));
    const firstController = new AbortController();
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = adapter.execute(
      request(firstController.signal, { onActivity: () => started() }),
    );
    await firstStarted;
    const queuedController = new AbortController();
    const second = adapter.execute(request(queuedController.signal));
    queuedController.abort(new Error("queued cancellation"));
    firstController.abort(new Error("first cancellation"));
    await expect(first).rejects.toMatchObject({ code: "cancellation" });
    await expect(second).rejects.toThrow();
    await closeAdapter(adapter);
  });

  it.each(["hang-initialize", "hang-session-new", "hang-model-selection"])(
    "aborts pending %s work and confirms process exit",
    async (mode) => {
      const cwd = temporaryDirectory();
      const exitFile = join(cwd, "exits");
      const eventFile = join(cwd, "events");
      const adapter = makeAdapter(
        configuration(cwd, mode, false, exitFile, undefined, eventFile),
      );
      const controller = new AbortController();
      const reason = Object.freeze({ kind: "test-abort" });
      const execution = adapter.execute(request(controller.signal));
      const marker =
        mode === "hang-initialize"
          ? "initialize"
          : mode === "hang-session-new"
            ? "session-new"
            : "model-selection";
      await waitForMarker(eventFile, marker);
      controller.abort(reason);
      const failure = await execution.catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ code: "cancellation" });
      expect(containsCause(failure, reason)).toBe(true);
      await waitForFile(exitFile);
      expect(readFileSync(exitFile, "utf8").trim()).toMatch(/^\d+$/);
    },
  );

  it("starts a fresh process for each non-persistent session when close is unavailable", async () => {
    const cwd = temporaryDirectory();
    const exitFile = join(cwd, "exits");
    const adapter = makeAdapter(
      configuration(cwd, "no-session-close", false, exitFile),
    );
    const first = resultSchema.parse(await adapter.execute(request()));
    await waitForFile(exitFile);
    const second = resultSchema.parse(await adapter.execute(request()));
    await waitForMarker(exitFile, `${second.processId}`);
    expect(second.processId).not.toBe(first.processId);
    expect(second.processPromptCount).toBe(1);
    await closeAdapter(adapter);
  });

  it("denies permission and terminates a peer that never resumes the prompt", async () => {
    const cwd = temporaryDirectory();
    const exitFile = join(cwd, "exits");
    const promptFile = join(cwd, "prompts");
    const adapter = makeAdapter(
      configuration(cwd, "permission-hang", false, exitFile, promptFile),
    );
    await expect(adapter.execute(request())).rejects.toBeInstanceOf(
      InteractionRequiredError,
    );
    await waitForFile(exitFile);
    expect(readFileSync(promptFile, "utf8")).toBe("prompt\n");
    await closeAdapter(adapter);
  });

  it.each([
    ["frozen Error", Object.freeze(new Error("activity sink failed"))],
    ["primitive", "activity sink failed"],
    ["null", null],
    ["undefined", undefined],
  ])(
    "stops native work before terminal callbacks when the %s activity sink fails",
    async (_label, primary) => {
      const cwd = temporaryDirectory();
      const eventFile = join(cwd, "events");
      const exitFile = join(cwd, "exits");
      const adapter = makeAdapter(
        configuration(cwd, "cancel", false, exitFile, undefined, eventFile),
      );
      const terminal = new Error("terminal sink failed");
      const execution = adapter.execute(
        request(undefined, {
          onActivity: (activity) => {
            if (activity.state === "started") throw primary;
            appendFileSync(eventFile, "terminal\n");
            throw terminal;
          },
        }),
      );
      const outcome = execution.catch((cause: unknown) => cause);
      await waitForMarker(eventFile, "cancel");
      const failure = await outcome;
      expect(containsCause(failure, primary)).toBe(true);
      expect(containsCause(failure, terminal)).toBe(true);
      expect(readFileSync(eventFile, "utf8").indexOf("cancel\n")).toBeLessThan(
        readFileSync(eventFile, "utf8").indexOf("terminal\n"),
      );
      await closeAdapter(adapter);
      await waitForFile(exitFile);
    },
  );

  it("closes a directly closed adapter during pending initialization", async () => {
    const cwd = temporaryDirectory();
    const eventFile = join(cwd, "events");
    const exitFile = join(cwd, "exits");
    const adapter = makeAdapter(
      configuration(
        cwd,
        "hang-initialize",
        false,
        exitFile,
        undefined,
        eventFile,
      ),
    );
    const execution = adapter.execute(request());
    const executionOutcome = execution.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await waitForMarker(eventFile, "initialize");
    await closeAdapter(adapter);
    expect(await executionOutcome).toBeInstanceOf(Error);
    await waitForFile(exitFile);
  });
});
