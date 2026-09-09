import {
  buildWorkflow,
  type SeqlaneEvent,
  type WorkflowDefinition,
} from "@seqlane/core";
import { createOpenCodeAdapter } from "@seqlane/opencode";
import {
  PlanCompiler,
  startCompiledWorkflow,
  type CompileWorkflowOptions,
} from "@seqlane/runtime";

import {
  type AgentRunnerPort,
  type AgentResolutionRequest,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import {
  seqlaneAgentExecutionResultSchema,
  validateSeqlaneAgentWorkflowOutput,
  type SeqlaneAgentExecutionRequest,
  validateAgentResolutionRequest,
} from "./agent-runner-port.js";
import type { OpenCodeRuntimeHandle } from "./opencode-runtime.js";
import { createBoundedRecording, type BoundedRecording } from "./recording.js";

export interface SeqlaneWorkflowInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly strategy: "merge" | "rebase";
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly conflictedFiles: readonly string[];
}

export const AGENT_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;

type SeqlaneExecutor =
  Extract<
    CompileWorkflowOptions["executors"],
    ReadonlyMap<string, unknown>
  > extends ReadonlyMap<string, infer Executor>
    ? Executor
    : never;

function createOpenCodeExecutor(
  taskDefinitions: ReturnType<typeof buildWorkflow>["taskDefinitions"],
  adapter: ReturnType<typeof createOpenCodeAdapter>,
): SeqlaneExecutor {
  return {
    execute: (request) => {
      const task = taskDefinitions.get(request.taskId);
      if (task === undefined || typeof task.goal !== "function") {
        throw new Error(
          `No agent task definition found for "${request.taskId}"`,
        );
      }
      return adapter.execute({
        invocationId: request.invocationId,
        // Forward per-invocation Mastra observability unchanged; the adapter uses
        // the current span only to parent child agent/tool spans.
        observability: request.observability,
        task,
        input: request.input,
        signal: request.signal,
        onMetrics: request.onMetrics,
        onDiagnostic: (diagnostic) =>
          request.onDiagnostic?.(diagnostic.message),
        onActivity: request.onActivity,
        onUncertainActivity: request.onUncertainActivity,
        onBackgroundProcess: request.onBackgroundProcess,
      });
    },
  };
}

export interface SeqlaneAgentRunnerOptions {
  readonly workspace: string;
  readonly workflow: WorkflowDefinition<SeqlaneWorkflowInput, unknown>;
  readonly openCode: {
    readonly start: (workspace: string) => Promise<OpenCodeRuntimeHandle>;
  };
  readonly repository?: string;
  readonly pullRequestNumber?: number;
  readonly strategy?: "merge" | "rebase";
  readonly baseBranch?: string;
  readonly headBranch?: string;
  readonly recording?: () => BoundedRecording;
  readonly attemptTimeoutMs?: number;
}

function agentError(message: string, cause?: unknown): ActionResolutionError {
  return new ActionResolutionError("agent", "AGENT_FAILED", message, cause);
}

export class SeqlaneAgentRunner implements AgentRunnerPort {
  private readonly options: SeqlaneAgentRunnerOptions;
  private runtime: OpenCodeRuntimeHandle | undefined;
  private adapter: ReturnType<typeof createOpenCodeAdapter> | undefined;
  private lastRecording: BoundedRecording | undefined;

  constructor(options: SeqlaneAgentRunnerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.runtime !== undefined && this.adapter !== undefined) return;
    if (this.runtime !== undefined || this.adapter !== undefined) {
      await this.stop();
    }
    const runtime = await this.options.openCode.start(this.options.workspace);
    this.runtime = runtime;
    this.adapter = createOpenCodeAdapter(runtime.connection);
  }

  async stop(): Promise<void> {
    const runtime = this.runtime;
    await runtime?.stop();
    this.adapter = undefined;
    this.runtime = undefined;
  }

  async resolve(request: AgentResolutionRequest) {
    const parsed = validateAgentResolutionRequest(request);
    await this.start();
    const execution = await this.execute({
      ...parsed,
      workspace: this.options.workspace,
    });
    const result = seqlaneAgentExecutionResultSchema.safeParse(execution);
    if (!result.success || result.data.status !== "succeeded") {
      throw agentError(
        "The Seqlane conflict-resolution task failed.",
        result.success ? result.data : result.error,
      );
    }
    try {
      return validateSeqlaneAgentWorkflowOutput(
        result.data.output,
        parsed.paths,
      );
    } catch (error: unknown) {
      throw agentError("The Seqlane workflow output was malformed.", error);
    }
  }

  private async execute(
    request: SeqlaneAgentExecutionRequest,
  ): Promise<unknown> {
    try {
      const adapter = this.adapter;
      if (adapter === undefined) {
        throw agentError("The OpenCode runtime is not started.");
      }
      const recording = this.options.recording?.() ?? createBoundedRecording();
      this.lastRecording = recording;
      const events = {
        emit: (event: SeqlaneEvent) => recording.record(event),
      };
      const built = buildWorkflow(this.options.workflow);
      const executor = createOpenCodeExecutor(built.taskDefinitions, adapter);
      const compiled = new PlanCompiler().compileWorkflow(built.plan, {
        executors: new Map([["opencode", executor]]),
        taskDefinitions: built.taskDefinitions,
        validatorDefinitions: built.validatorDefinitions,
        workflowInput: {
          repository: this.options.repository ?? request.workspace,
          pullRequestNumber: this.options.pullRequestNumber ?? 0,
          strategy: this.options.strategy ?? "rebase",
          baseBranch: this.options.baseBranch ?? "unknown",
          headBranch: this.options.headBranch ?? "unknown",
          baseRevision: request.baseRevision,
          headRevision: request.headRevision,
          conflictedFiles: request.paths,
        },
        events,
      });
      const attemptController = new AbortController();
      const timeout = setTimeout(
        () => attemptController.abort(),
        this.options.attemptTimeoutMs ?? AGENT_ATTEMPT_TIMEOUT_MS,
      );
      try {
        const active = startCompiledWorkflow(compiled, {
          signal: attemptController.signal,
        });
        const outcome = await active.outcome;
        if (outcome.status === "succeeded") {
          return { status: "succeeded", output: outcome.result };
        }
        if (
          outcome.status === "cancelled" &&
          attemptController.signal.aborted
        ) {
          throw agentError(
            "The conflict-resolution attempt exceeded its deadline.",
          );
        }
        if (outcome.status === "cancelled") return outcome;
        throw agentError(
          "The Seqlane workflow returned a failure.",
          outcome.error,
        );
      } finally {
        clearTimeout(timeout);
      }
    } catch (error: unknown) {
      if (error instanceof ActionResolutionError) throw error;
      throw agentError("The Seqlane workflow could not be executed.", error);
    }
  }

  getAttemptDiagnostics() {
    return {
      eventCount: this.lastRecording?.events.length ?? 0,
      truncated: this.lastRecording?.truncated ?? false,
    };
  }
}

export function createSeqlaneAgentRunner(
  options: SeqlaneAgentRunnerOptions,
): AgentRunnerPort {
  return new SeqlaneAgentRunner(options);
}
