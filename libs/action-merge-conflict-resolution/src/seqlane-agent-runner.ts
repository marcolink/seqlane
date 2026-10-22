import { Effect } from "effect";
import type { AgentRuntime } from "@seqlane/agent-adapter";
import {
  buildWorkflow,
  type AuthoredWorkflow,
  type SeqlaneEvent,
} from "@seqlane/core";
import { createOpenCodeAgentRuntimeFactory } from "@seqlane/opencode-adapter";
import {
  startWorkflowRun,
  type StartWorkflowRunRequest,
  type WorkflowRunHandle,
} from "@seqlane/runtime";
import type {
  ResolveMergeConflictsWorkflowInput,
  ResolveMergeConflictsWorkflowOutput,
} from "@seqlane/resolve-merge-conflicts-workflow";

import {
  type AgentRunnerPort,
  type AgentResolutionRequest,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import {
  validateSeqlaneAgentWorkflowOutput,
  validateAgentResolutionRequest,
} from "./agent-runner-port.js";
import type { OpenCodeRuntimeHandle } from "./opencode-runtime.js";
import { createBoundedRecording, type BoundedRecording } from "./recording.js";

interface SeqlaneAgentExecutionRequest extends AgentResolutionRequest {
  readonly workspace: string;
}

export type SeqlaneWorkflowInput = ResolveMergeConflictsWorkflowInput;

export const AGENT_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;

type AgentRuntimeFactoryForAttempt = (
  connection: OpenCodeRuntimeHandle["connection"],
  workspace: string,
  signal: AbortSignal,
) => Promise<AgentRuntime>;

function agentError(message: string, cause?: unknown): ActionResolutionError {
  return new ActionResolutionError("agent", "AGENT_FAILED", message, cause);
}

async function createNativeAgentRuntime(
  connection: OpenCodeRuntimeHandle["connection"],
  workspace: string,
  signal: AbortSignal,
): Promise<AgentRuntime> {
  const factory = createOpenCodeAgentRuntimeFactory({
    adapter: "opencode",
    url: connection.url,
    workspace: connection.workspace ?? workspace,
  });
  return factory(signal, workspace);
}

async function runWithAttemptDeadline(
  start: () => WorkflowRunHandle,
  controller: AbortController,
  timeoutMs: number,
): Promise<{
  readonly handle: WorkflowRunHandle;
  readonly outcome: Awaited<WorkflowRunHandle["outcome"]>;
  readonly timedOut: boolean;
}> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* Effect.sync(start);
      const completed = yield* Effect.raceFirst(
        Effect.promise(() => handle.outcome).pipe(
          Effect.map((outcome) => ({ kind: "completed" as const, outcome })),
        ),
        Effect.sleep(`${timeoutMs} millis`).pipe(
          Effect.as({ kind: "deadline" as const }),
        ),
      );
      if (completed.kind === "completed") {
        return { handle, outcome: completed.outcome, timedOut: false };
      }

      controller.abort();
      // The Effect deadline requests cancellation; the run facade remains the
      // authority for SDK acknowledgement and run-owned resource cleanup.
      yield* Effect.promise(() => handle.cancel());
      const outcome = yield* Effect.promise(() => handle.outcome);
      return { handle, outcome, timedOut: true };
    }),
  );
}

export interface SeqlaneAgentRunnerOptions {
  readonly workspace: string;
  readonly workflow: AuthoredWorkflow<
    SeqlaneWorkflowInput,
    ResolveMergeConflictsWorkflowOutput
  >;
  readonly openCode: {
    readonly start: (
      workspace: string,
      shutdownSignal?: AbortSignal,
    ) => Promise<OpenCodeRuntimeHandle>;
  };
  readonly repository?: string;
  readonly pullRequestNumber?: number;
  readonly strategy?: "merge" | "rebase";
  readonly baseBranch?: string;
  readonly headBranch?: string;
  readonly recording?: () => BoundedRecording;
  readonly attemptTimeoutMs?: number;
  /** Test and host seam for a directly composed native AgentRuntime. */
  readonly createAgentRuntime?: AgentRuntimeFactoryForAttempt;
  readonly onObservation?: StartWorkflowRunRequest["onObservation"];
  /** Action shutdown signal propagated to every active attempt. */
  readonly shutdownSignal?: AbortSignal;
}

interface ActiveAgentAttempt {
  readonly controller: AbortController;
  handle: WorkflowRunHandle | undefined;
  settlement: Promise<void>;
}

export class SeqlaneAgentRunner implements AgentRunnerPort {
  private readonly options: SeqlaneAgentRunnerOptions;
  private runtime: OpenCodeRuntimeHandle | undefined;
  private runtimeStart: Promise<OpenCodeRuntimeHandle> | undefined;
  private runtimeStop: Promise<void> | undefined;
  private activeAttempt: ActiveAgentAttempt | undefined;
  private lastRecording: BoundedRecording | undefined;

  constructor(options: SeqlaneAgentRunnerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.runtimeStop !== undefined) await this.runtimeStop;
    if (this.runtime !== undefined) return;
    if (this.runtimeStart === undefined) {
      const starting = this.options.openCode
        .start(this.options.workspace, this.options.shutdownSignal)
        .then((runtime) => {
          this.runtime = runtime;
          return runtime;
        })
        .finally(() => {
          if (this.runtimeStart === starting) this.runtimeStart = undefined;
        });
      this.runtimeStart = starting;
    }
    await this.runtimeStart;
  }

  async stop(): Promise<void> {
    if (this.runtimeStop !== undefined) return this.runtimeStop;
    const stopping = Promise.resolve().then(() => this.stopOwnedResources());
    const wrapped = stopping.finally(() => {
      if (this.runtimeStop === wrapped) this.runtimeStop = undefined;
    });
    this.runtimeStop = wrapped;
    return wrapped;
  }

  private async stopOwnedResources(): Promise<void> {
    const attempt = this.activeAttempt;
    const failures: unknown[] = [];
    if (attempt !== undefined) {
      attempt.controller.abort();
      try {
        await attempt.handle?.cancel();
      } catch (error: unknown) {
        failures.push(error);
      }
    }

    const starting = this.runtimeStart;
    if (starting !== undefined) {
      try {
        await starting;
      } catch {
        // Startup owns its failure; stop still completes any acquired cleanup.
      }
    }

    if (attempt !== undefined) await attempt.settlement;

    const runtime = this.runtime;
    try {
      await runtime?.stop();
      if (this.runtime === runtime) this.runtime = undefined;
    } catch (error: unknown) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Multiple runner cleanup steps failed.",
        {
          cause: failures[0],
        },
      );
    }
  }

  async resolve(request: AgentResolutionRequest) {
    const parsed = validateAgentResolutionRequest(request);
    if (this.runtimeStop !== undefined || this.activeAttempt !== undefined) {
      throw agentError(
        "The conflict-resolution runner is already active or stopping.",
      );
    }
    const attempt: ActiveAgentAttempt = {
      controller: new AbortController(),
      handle: undefined,
      settlement: Promise.resolve(),
    };
    const interrupt = () =>
      attempt.controller.abort(this.options.shutdownSignal?.reason);
    if (this.options.shutdownSignal?.aborted) interrupt();
    else
      this.options.shutdownSignal?.addEventListener("abort", interrupt, {
        once: true,
      });
    this.activeAttempt = attempt;
    const work = this.execute(
      {
        ...parsed,
        workspace: this.options.workspace,
      },
      attempt,
    );
    attempt.settlement = work
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.options.shutdownSignal?.removeEventListener("abort", interrupt);
        if (this.activeAttempt === attempt) this.activeAttempt = undefined;
      });
    const execution = await work;
    if (execution.timedOut) {
      throw agentError(
        "The conflict-resolution attempt exceeded its deadline.",
        execution.outcome.status === "failed"
          ? execution.outcome.error
          : execution.outcome,
      );
    }
    if (execution.outcome.status !== "succeeded") {
      throw agentError(
        "The Seqlane conflict-resolution task failed.",
        execution.outcome.status === "failed"
          ? execution.outcome.error
          : execution.outcome,
      );
    }
    try {
      return validateSeqlaneAgentWorkflowOutput(
        execution.outcome.result,
        parsed.paths,
      );
    } catch (error: unknown) {
      throw agentError("The Seqlane workflow output was malformed.", error);
    }
  }

  private async execute(
    request: SeqlaneAgentExecutionRequest,
    attempt: ActiveAgentAttempt,
  ): Promise<{
    readonly outcome: Awaited<WorkflowRunHandle["outcome"]>;
    readonly timedOut: boolean;
  }> {
    try {
      if (attempt.controller.signal.aborted) {
        throw attempt.controller.signal.reason;
      }
      await this.start();
      const runtime = this.runtime;
      if (runtime === undefined) {
        throw agentError("The OpenCode runtime is not started.");
      }
      const recording = this.options.recording?.() ?? createBoundedRecording();
      this.lastRecording = recording;
      const events = {
        emit: (event: SeqlaneEvent) => recording.record(event),
      };
      const built = buildWorkflow(this.options.workflow);
      const createRuntime =
        this.options.createAgentRuntime ?? createNativeAgentRuntime;
      const agentRuntime = await createRuntime(
        runtime.connection,
        request.workspace,
        attempt.controller.signal,
      );
      let adopted = false;
      try {
        const result = await runWithAttemptDeadline(
          () => {
            const handle = startWorkflowRun({
              workflow: built,
              input: {
                repository: this.options.repository ?? request.workspace,
                pullRequestNumber: this.options.pullRequestNumber ?? 0,
                strategy: this.options.strategy ?? "rebase",
                baseBranch: this.options.baseBranch ?? "unknown",
                headBranch: this.options.headBranch ?? "unknown",
                baseRevision: request.baseRevision,
                headRevision: request.headRevision,
                conflictedFiles: request.paths,
              },
              agentRuntime,
              workspace: request.workspace,
              events,
              signal: attempt.controller.signal,
              onObservation: this.options.onObservation,
            });
            adopted = true;
            attempt.handle = handle;
            return handle;
          },
          attempt.controller,
          this.options.attemptTimeoutMs ?? AGENT_ATTEMPT_TIMEOUT_MS,
        );
        return { outcome: result.outcome, timedOut: result.timedOut };
      } finally {
        if (!adopted) await agentRuntime.close?.();
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
