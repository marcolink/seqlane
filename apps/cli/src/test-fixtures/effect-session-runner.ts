import { startRunnerProcess } from "@seqlane/runtime/runner";
import type {
  AgentAdapter,
  AgentRuntime,
  AgentRuntimeFactory,
} from "@seqlane/agent-adapter";
import { access, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const inputSchema = z.strictObject({
  traceDir: z.string().min(1),
});

const checkpointSchema = z.strictObject({
  sourceAdapterId: z.string().min(1),
  lineage: z.string().min(1),
});

let nextAdapterId = 0;

async function record(
  traceDir: string,
  event: Readonly<Record<string, unknown>>,
): Promise<void> {
  await appendFile(join(traceDir, "trace.jsonl"), `${JSON.stringify(event)}\n`);
}

async function waitForRelease(
  traceDir: string,
  signal: AbortSignal,
): Promise<void> {
  const release = join(traceDir, "release");
  const deadline = Date.now() + 15_000;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      await access(release);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(
    signal.aborted
      ? "Generic adapter fixture execution was cancelled"
      : "Timed out waiting for the generic adapter fixture release marker",
  );
}

function createAdapter(lineage?: string): {
  readonly adapter: AgentAdapter;
  readonly adapterId: string;
} {
  const adapterId = `adapter-${++nextAdapterId}`;
  let closeTraceDir: string | undefined;
  const adapter: AgentAdapter = {
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
    async execute(request) {
      const input = inputSchema.parse(request.input);
      request.onExecutionStarted();
      closeTraceDir = input.traceDir;
      await record(input.traceDir, {
        event: "execute.started",
        adapterId,
        lineage: lineage ?? adapterId,
        taskId: request.task.id,
        modelSelection: request.modelSelection ?? null,
      });
      if (request.task.id === "effect-session-source") {
        request.onObservation?.({
          observationId: `generic-fixture:${request.invocationId}`,
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
      }
      try {
        await access(join(input.traceDir, "gate"));
        if (request.task.id !== "effect-session-shared-source") {
          await waitForRelease(input.traceDir, request.signal);
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
      await record(input.traceDir, {
        event: "execute.finished",
        adapterId,
        lineage: lineage ?? adapterId,
        taskId: request.task.id,
        modelSelection: request.modelSelection ?? null,
      });
      return { value: request.task.id };
    },
    async captureCheckpoint() {
      const value = {
        sourceAdapterId: adapterId,
        lineage: lineage ?? adapterId,
      };
      if (closeTraceDir !== undefined) {
        await record(closeTraceDir, { event: "checkpoint.captured", ...value });
      }
      return value;
    },
    async fork(request) {
      const checkpoint = checkpointSchema.parse(request.checkpoint);
      const child = createAdapter(checkpoint.lineage);
      if (closeTraceDir !== undefined) {
        await record(closeTraceDir, {
          event: "adapter.forked",
          sourceAdapterId: adapterId,
          adapterId: child.adapterId,
          lineage: checkpoint.lineage,
          modelSelection: request.modelSelection ?? null,
        });
      }
      return child.adapter;
    },
    async close() {
      if (closeTraceDir !== undefined) {
        await record(closeTraceDir, { event: "adapter.close", adapterId });
      }
    },
  };
  return { adapter, adapterId };
}

const createAgentRuntimeFactory: AgentRuntimeFactory = async () => {
  const runtime: AgentRuntime = {
    identity: "generic-cli-fixture",
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
    modelCapabilities: {
      executor: "generic-cli-fixture",
      listModels: async () => [{ provider: "openai", model: "gpt-5.6-luna" }],
      resolveDefaultModel: async () => ({
        model: { provider: "openai", model: "gpt-5.6-luna" },
      }),
    },
    createAdapter: () => createAdapter().adapter,
    redactAdapter: (adapter) => adapter,
    async close() {
      // Adapter close events are written by each session below.
    },
  };
  return runtime;
};

startRunnerProcess({
  workerEntrypoint: true,
  createAgentRuntimeFactory: () => createAgentRuntimeFactory,
});
