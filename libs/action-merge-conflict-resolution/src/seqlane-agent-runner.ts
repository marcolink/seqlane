import {
  buildWorkflow,
  type SeqlaneEvent,
  type WorkflowDefinition,
} from "@seqlane/core";
import { createOpenCodeExecutor, createOpenCodeRun } from "@seqlane/opencode";
import { EffectCompiler, runCompiledWorkflow } from "@seqlane/runtime";

import {
  type AgentRunnerPort,
  type AgentResolutionRequest,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import {
  seqlaneAgentExecutionResultSchema,
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
  readonly recording?: BoundedRecording;
}

function agentError(message: string, cause?: unknown): ActionResolutionError {
  return new ActionResolutionError("agent", "AGENT_FAILED", message, cause);
}

export class SeqlaneAgentRunner implements AgentRunnerPort {
  private readonly options: SeqlaneAgentRunnerOptions;

  constructor(options: SeqlaneAgentRunnerOptions) {
    this.options = options;
  }

  async resolve(request: AgentResolutionRequest): Promise<void> {
    const parsed = validateAgentResolutionRequest(request);
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
  }

  private async execute(
    request: SeqlaneAgentExecutionRequest,
  ): Promise<unknown> {
    let handle: OpenCodeRuntimeHandle | undefined;
    let run: Awaited<ReturnType<typeof createOpenCodeRun>> | undefined;
    try {
      handle = await this.options.openCode.start(request.workspace);
      const recording = this.options.recording ?? createBoundedRecording();
      const events = {
        emit: (event: SeqlaneEvent) => recording.record(event),
      };
      run = await createOpenCodeRun(handle.connection);
      const built = buildWorkflow(this.options.workflow);
      const executor = createOpenCodeExecutor(built.taskDefinitions, run);
      const compiled = new EffectCompiler().compileWorkflow(built.plan, {
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
      const outcome = await runCompiledWorkflow(compiled);
      if (outcome.status === "succeeded") {
        return { status: "succeeded", output: outcome.result };
      }
      if (outcome.status === "cancelled") return outcome;
      throw agentError(
        "The Seqlane workflow returned a failure.",
        outcome.error,
      );
    } catch (error: unknown) {
      if (error instanceof ActionResolutionError) throw error;
      throw agentError("The Seqlane workflow could not be executed.", error);
    } finally {
      await run?.abort().catch(() => undefined);
      await handle?.stop();
    }
  }
}

export function createSeqlaneAgentRunner(
  options: SeqlaneAgentRunnerOptions,
): AgentRunnerPort {
  return new SeqlaneAgentRunner(options);
}
