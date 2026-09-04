import type {
  AgentActivity,
  AgentAdapter,
  AgentAdapterRequest,
} from "@seqlane/agent-adapter";
import type { ModelSelection } from "@seqlane/core";
import { buildOpenCodePrompt } from "./task-prompt.js";
import {
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
import type {
  OpenCodeActivity,
  OpenCodeConnection,
  OpenCodeRun,
} from "./protocol.js";
import { createOpenCodeRun } from "./session.js";

export interface OpenCodeAdapterOptions {
  /** Runtime-wide cancellation for session creation and session operations. */
  readonly signal?: AbortSignal;
  /** Pins one model selection to every prompt in this adapter session. */
  readonly modelSelection?: ModelSelection;
}

function promptStrategyDiagnostic(
  selection: ResolvedStructuredOutput,
): string | undefined {
  if (selection.strategy !== "prompt" || selection.reason === "explicit") {
    return undefined;
  }
  const version =
    selection.version === undefined ? "" : ` for OpenCode ${selection.version}`;
  const reason =
    selection.reason === "affected-version"
      ? "the native implementation is on the compatibility list"
      : selection.reason === "unknown-version"
        ? "the OpenCode version is not verified"
        : selection.reason === "runtime-downgrade"
          ? "native output readback was not compatible"
          : "the runtime selected the compatibility fallback";
  return (
    `OpenCode structured output fallback is active${version}: using prompt mode because ${reason}. ` +
    "The JSON response is validated and repaired before task completion."
  );
}

function normalizeActivity(activity: OpenCodeActivity): AgentActivity {
  return {
    activityId: activity.activityId,
    kind: activity.kind,
    name: activity.name,
    state: activity.state,
    ...(activity.input === undefined ? {} : { input: activity.input }),
    ...(activity.output === undefined ? {} : { output: activity.output }),
    ...(activity.message === undefined ? {} : { message: activity.message }),
  };
}

function createAdapterForRun(
  resolveRun: (signal: AbortSignal) => Promise<OpenCodeRun>,
  configuredSelection: ModelSelection | undefined,
  sessionUi: () => Promise<string | undefined>,
  hasSessionUi: boolean,
): AgentAdapter {
  return {
    capabilities: {
      execute: true,
      modelSelection: true,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: true,
      fork: true,
      activity: true,
      sessionUi: hasSessionUi,
    },

    async execute(request: AgentAdapterRequest): Promise<unknown> {
      const schema = toOpenCodeJsonSchema(request.task);
      const run = await resolveRun(request.signal);
      const selection = await run.structuredOutput?.();
      const strategy = selection?.strategy ?? "native";
      const retryCount = selection?.retryCount ?? 0;
      const diagnostic =
        selection === undefined
          ? undefined
          : promptStrategyDiagnostic(selection);
      if (diagnostic !== undefined) {
        request.onDiagnostic?.({ code: "structured-output", message: diagnostic });
      }

      const basePrompt = buildOpenCodePrompt(request.task, request.input);
      let promptText =
        strategy === "prompt"
          ? buildStructuredOutputPrompt(basePrompt, schema)
          : basePrompt;
      let attempts = 0;
      let lastIssues: StructuredOutputValidationError | undefined;

      while (true) {
        attempts += 1;
        selection?.report?.({ type: "attempt", attempt: attempts });
        const response = await run.prompt({
          text: promptText,
          schema,
          strategy,
          retryCount,
          ...(lastIssues === undefined
            ? {}
            : { tools: { "*": false, StructuredOutput: true } }),
          selection: request.modelSelection ?? configuredSelection,
          signal: request.signal,
          onActivity: (activity) =>
            request.onActivity?.(normalizeActivity(activity)),
        });
        if (response.metrics !== undefined) {
          request.onMetrics?.(response.metrics);
        }
        if (strategy === "native") {
          selection?.report?.({
            type: "completed",
            attempt: attempts,
            success: true,
          });
          return response.structured;
        }

        try {
          const parsed = parsePromptJson(response.text ?? "");
          const output = validatePromptJson(parsed, request.task.output);
          selection?.report?.({
            type: "completed",
            attempt: attempts,
            success: true,
          });
          return output;
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
          if (attempts > retryCount) {
            selection?.report?.({
              type: "completed",
              attempt: attempts,
              success: false,
            });
            throw new StructuredOutputValidationError(
              attempts,
              validationError.issues,
              validationError,
            );
          }
          promptText = buildStructuredOutputRepairPrompt(
            summarizeStructuredOutputIssues(validationError.issues),
          );
        }
      }
    },

    ...(hasSessionUi ? { sessionUi } : {}),
    captureCheckpoint: async () =>
      (await resolveRun(new AbortController().signal)).checkpoint(),
    fork: async ({ checkpoint, modelSelection }) => {
      const child = await (
        await resolveRun(new AbortController().signal)
      ).fork(checkpoint, modelSelection ?? configuredSelection);
      return createAdapterForRun(
        () => Promise.resolve(child),
        modelSelection ?? configuredSelection,
        async () => child.browserUrl,
        child.browserUrl !== undefined,
      );
    },
  };
}

/** Test seam for the adapter contract; production uses the SDK-backed factory below. */
export function createOpenCodeAdapterForRun(
  run: OpenCodeRun,
  modelSelection?: ModelSelection,
): AgentAdapter {
  return createAdapterForRun(
    () => Promise.resolve(run),
    modelSelection,
    async () => run.browserUrl,
    run.browserUrl !== undefined,
  );
}

/** Creates the sole OpenCode task adapter backed by the OpenCode SDK. */
export function createOpenCodeAdapter(
  connection: OpenCodeConnection,
  options: OpenCodeAdapterOptions = {},
): AgentAdapter {
  let run: Promise<OpenCodeRun> | undefined;
  const resolveRun = (signal: AbortSignal): Promise<OpenCodeRun> =>
    (run ??= createOpenCodeRun(
      connection,
      options.signal ?? signal,
      options.modelSelection,
    ));

  return createAdapterForRun(
    resolveRun,
    options.modelSelection,
    async () =>
      (await resolveRun(options.signal ?? new AbortController().signal))
        .browserUrl,
    connection.browserUiUrl !== undefined,
  );
}
