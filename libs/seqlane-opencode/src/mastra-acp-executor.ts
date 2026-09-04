import { AcpAgent, type AcpAgentOptions } from "@mastra/acp";
import type { AgentStreamOptions } from "@mastra/core/agent";
import type { MessageListInput } from "@mastra/core/agent/message-list";
import {
  InteractionRequiredError,
  type ModelSelection,
  type TaskDefinitionRegistry,
} from "@seqlane/core";
import { getOpenCodeTask } from "./task.js";
import {
  buildOpenCodePrompt,
  buildStructuredOutputPrompt,
  buildStructuredOutputRepairPrompt,
} from "./task-prompt.js";
import { toOpenCodeJsonSchema } from "./task-schema.js";
import {
  parsePromptJson,
  summarizeStructuredOutputIssues,
  validatePromptJson,
} from "./structured-output-parser.js";
import { StructuredOutputValidationError } from "./errors.js";
import type { ResolvedStructuredOutput } from "./structured-output-strategy.js";
import type { OpenCodeExecutor, OpenCodeExecutorRequest } from "./executor.js";
import type { OpenCodeActivity } from "./protocol.js";

interface MastraAcpStream {
  readonly fullStream: ReadableStream<unknown>;
  readonly text: Promise<string>;
}

interface MastraAcpAgent {
  stream(
    messages: MessageListInput,
    options: Pick<AgentStreamOptions, "abortSignal" | "runId">,
  ): Promise<MastraAcpStream>;
}

type CreateMastraAcpAgent = (options: AcpAgentOptions) => MastraAcpAgent;

export interface MastraAcpExecutorOptions {
  readonly workspace?: string;
  readonly selection?: ModelSelection;
  readonly resolveStructuredOutput?: () => Promise<ResolvedStructuredOutput>;
  /** Test seam for the Mastra ACP boundary. */
  readonly createAgent?: CreateMastraAcpAgent;
}

function createDefaultAgent(options: AcpAgentOptions): MastraAcpAgent {
  return new AcpAgent(options);
}

const cancelPermissionRequest: NonNullable<
  AcpAgentOptions["onPermissionRequest"]
> = async () => ({
  outcome: { outcome: "cancelled" },
});

function modelId(selection: ModelSelection | undefined): string | undefined {
  return selection === undefined
    ? undefined
    : `${selection.model.provider}/${selection.model.model}`;
}

function reportActivity(
  chunk: unknown,
  onActivity: ((activity: OpenCodeActivity) => void) | undefined,
  activities: Set<string>,
): void {
  if (typeof chunk !== "object" || chunk === null) return;
  const record = chunk as Record<string, unknown>;
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return;
  const values = payload as Record<string, unknown>;
  const activityId = values.toolCallId;
  const name = values.toolName;
  if (typeof activityId !== "string" || typeof name !== "string") return;

  if (record.type === "tool-call-delta") {
    activities.add(activityId);
    onActivity?.({
      activityId,
      kind: name.toLowerCase().includes("skill") ? "skill" : "tool",
      name,
      state: "started",
    });
    return;
  }

  if (record.type !== "tool-result" || !activities.has(activityId)) return;
  const isError = values.isError === true;
  onActivity?.({
    activityId,
    kind: name.toLowerCase().includes("skill") ? "skill" : "tool",
    name,
    state: isError ? "failed" : "succeeded",
    ...(values.result === undefined ? {} : { output: values.result }),
    ...(isError ? { message: "Tool failed" } : {}),
  });
}

async function promptAgent(
  agent: MastraAcpAgent,
  prompt: string,
  request: OpenCodeExecutorRequest,
): Promise<string> {
  const stream = await agent.stream([{ role: "user", content: prompt }], {
    abortSignal: request.signal,
    runId: request.invocationId,
  });
  const reader = stream.fullStream.getReader();
  const activities = new Set<string>();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      reportActivity(next.value, request.onActivity, activities);
    }
  } catch (cause) {
    await stream.text.catch(() => undefined);
    throw cause;
  } finally {
    reader.releaseLock();
  }
  return stream.text;
}

function structuredOutputDiagnostic(
  selection: ResolvedStructuredOutput,
): string | undefined {
  if (selection.strategy === "prompt") return undefined;
  return (
    "Mastra ACP does not expose OpenCode native structured-output readback; " +
    "the Seqlane adapter uses its validated JSON prompt contract."
  );
}

function reasoningDiagnostic(
  selection: ModelSelection | undefined,
): string | undefined {
  if (selection?.reasoning === undefined) return undefined;
  return (
    `Mastra ACP 0.4.0 selects ${selection.model.provider}/${selection.model.model}, ` +
    `but does not expose OpenCode's native reasoning variant (${selection.reasoning}); ` +
    "the native OpenCode adapter remains the documented escape hatch for that capability."
  );
}

/**
 * Transitional, local-only ACP bridge for the initial Mastra integration.
 *
 * This adapter deliberately accepts a workspace, not an OpenCode connection:
 * Mastra ACP 0.4 starts a command locally and does not expose OpenCode's
 * remote endpoint or native checkpoint/fork semantics. Keep it separate from
 * `createOpenCodeExecutor`, which owns the OpenCode SDK session contract.
 * A future generic ACP adapter can reuse the ACP lifecycle without making
 * OpenCode-specific assumptions; do not use this bridge for a session that
 * promises configured endpoints or native checkpoint branching.
 */
export function createMastraAcpExecutor(
  tasks: TaskDefinitionRegistry,
  options: MastraAcpExecutorOptions,
): OpenCodeExecutor {
  const createAgent = options.createAgent ?? createDefaultAgent;
  let permissionRequested = false;
  const agent = createAgent({
    id: "seqlane-opencode-acp",
    name: "Seqlane OpenCode ACP agent",
    description: "Executes Seqlane coding tasks through OpenCode ACP.",
    command: "opencode",
    args: ["acp"],
    ...(options.workspace === undefined ? {} : { cwd: options.workspace }),
    ...(modelId(options.selection) === undefined
      ? {}
      : { model: modelId(options.selection) }),
    persistSession: true,
    onPermissionRequest: async (request) => {
      permissionRequested = true;
      return cancelPermissionRequest(request);
    },
  });
  let structuredDiagnosticReported = false;
  let reasoningDiagnosticReported = false;

  return {
    async execute(request) {
      permissionRequested = false;
      const task = getOpenCodeTask(tasks, request.taskId);
      const schema = toOpenCodeJsonSchema(task);
      const structured =
        (await options.resolveStructuredOutput?.()) ??
        ({ strategy: "prompt", retryCount: 2, reason: "explicit" } as const);
      const diagnostic = structuredOutputDiagnostic(structured);
      if (diagnostic !== undefined && !structuredDiagnosticReported) {
        structuredDiagnosticReported = true;
        request.onDiagnostic?.(diagnostic);
      }
      const reasoning = reasoningDiagnostic(options.selection);
      if (reasoning !== undefined && !reasoningDiagnosticReported) {
        reasoningDiagnosticReported = true;
        request.onDiagnostic?.(reasoning);
      }

      const basePrompt = buildOpenCodePrompt(task, request.input);
      let promptText = buildStructuredOutputPrompt(basePrompt, schema);
      let attempts = 0;
      let lastIssues: StructuredOutputValidationError | undefined;

      while (true) {
        attempts += 1;
        const startedAt = Date.now();
        let text: string;
        try {
          text = await promptAgent(agent, promptText, request);
        } catch (cause) {
          if (permissionRequested) {
            throw new InteractionRequiredError("user-input");
          }
          throw cause;
        }
        if (permissionRequested) {
          throw new InteractionRequiredError("user-input");
        }
        request.onMetrics?.({
          durationMs: Math.max(0, Date.now() - startedAt),
          ...(options.selection === undefined
            ? {}
            : {
                model: options.selection.model.model,
                provider: options.selection.model.provider,
              }),
        });
        try {
          return validatePromptJson(parsePromptJson(text), task.output);
        } catch (cause) {
          const validationError =
            cause instanceof StructuredOutputValidationError
              ? cause
              : new StructuredOutputValidationError(
                  1,
                  [
                    {
                      kind: "validation",
                      code: "schema_validation_failed",
                      message: "Output did not satisfy the task schema",
                    },
                  ],
                  cause,
                );
          lastIssues = validationError;
          if (attempts > structured.retryCount) {
            throw new StructuredOutputValidationError(
              attempts,
              validationError.issues,
              validationError,
            );
          }
          promptText = buildStructuredOutputRepairPrompt(
            summarizeStructuredOutputIssues(lastIssues.issues),
          );
        }
      }
    },
  };
}
