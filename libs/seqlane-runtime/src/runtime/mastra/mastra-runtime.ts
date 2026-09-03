import { Mastra } from "@mastra/core/mastra";
import type { AnyWorkflow } from "@mastra/core/workflows";
import type { RunId, SeqlaneRunOutcome, WorkId } from "@seqlane/core";
import { RuntimeError } from "@seqlane/core";

export interface MastraWorkflowRegistration {
  readonly key: string;
  readonly workflow: AnyWorkflow;
}

export interface MastraRunRequest {
  readonly workflowKey: string;
  readonly input: unknown;
  readonly workId: WorkId;
  readonly runId: RunId;
}

export interface MastraRuntime {
  run(request: MastraRunRequest): Promise<SeqlaneRunOutcome>;
  start(request: MastraRunRequest): MastraActiveRun;
}

export interface MastraActiveRun {
  readonly outcome: Promise<SeqlaneRunOutcome>;
  cancel(): Promise<void>;
}

function validateRegistrations(
  registrations: readonly MastraWorkflowRegistration[],
): void {
  if (registrations.length === 0) {
    throw new TypeError("At least one Mastra workflow must be registered");
  }

  const keys = new Set<string>();
  for (const registration of registrations) {
    if (registration.key.length === 0) {
      throw new TypeError(
        "Mastra workflow registration keys must not be empty",
      );
    }
    if (keys.has(registration.key)) {
      throw new TypeError(
        `Mastra workflow registration key is duplicated: "${registration.key}"`,
      );
    }
    keys.add(registration.key);
  }
}

function failedOutcome(cause: unknown): SeqlaneRunOutcome {
  // Mastra serializes failed workflow errors before returning them. Restore
  // the message for the stable Seqlane error while retaining that payload as
  // the restored error's cause.
  const normalizedCause =
    cause instanceof Error
      ? cause
      : typeof cause === "object" &&
          cause !== null &&
          "message" in cause &&
          typeof cause.message === "string"
        ? new Error(cause.message, { cause })
        : cause;

  return {
    status: "failed",
    error: new RuntimeError(normalizedCause),
  };
}

function normalizeResult(
  workflowKey: string,
  result: {
    readonly status: string;
    readonly result?: unknown;
    readonly error?: unknown;
  },
): SeqlaneRunOutcome {
  if (result.status === "success") {
    return {
      status: "succeeded",
      result: result.result,
    };
  }

  if (result.status === "failed") {
    return failedOutcome(result.error);
  }

  if (result.status === "canceled" || result.status === "cancelled") {
    return { status: "cancelled" };
  }

  return failedOutcome(
    new Error(
      `Mastra workflow "${workflowKey}" ended with unsupported status "${result.status}"`,
    ),
  );
}

export function createMastraRuntime(
  registrations: readonly MastraWorkflowRegistration[],
): MastraRuntime {
  validateRegistrations(registrations);

  const workflows: Record<string, AnyWorkflow> = Object.fromEntries(
    registrations.map(({ key, workflow }) => [key, workflow]),
  );
  const mastra = new Mastra({ workflows, logger: false });

  return {
    run(request) {
      return this.start(request).outcome;
    },
    start(request) {
      let activeRun: Awaited<ReturnType<AnyWorkflow["createRun"]>> | undefined;
      let cancellationRequested = false;
      const outcome = (async () => {
        try {
          const workflow = mastra.getWorkflow(request.workflowKey);
          activeRun = await workflow.createRun({
            runId: request.runId,
            resourceId: request.workId,
          });
          if (cancellationRequested) {
            await activeRun.cancel();
            return { status: "cancelled" } as const;
          }
          const result = await activeRun.start({ inputData: request.input });
          return normalizeResult(request.workflowKey, result);
        } catch (cause) {
          if (cancellationRequested) return { status: "cancelled" } as const;
          return failedOutcome(cause);
        }
      })();

      return {
        outcome,
        cancel: async () => {
          cancellationRequested = true;
          await activeRun?.cancel();
        },
      };
    },
  };
}
