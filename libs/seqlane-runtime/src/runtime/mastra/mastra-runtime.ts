import { createHash, randomUUID } from "node:crypto";
import { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { InMemoryStore } from "@mastra/core/storage";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import type { RunId, SeqlaneRunOutcome, WorkId } from "@seqlane/core";
import { RuntimeError, SeqlaneError } from "@seqlane/core";
import {
  registerMastraServer,
  type MastraServerRequestContext,
  type MastraRuntimeServer,
} from "./mastra-server.js";

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

export interface MastraRunContext extends MastraServerRequestContext {}

export interface MastraWorkflowResult {
  readonly status: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly steps?: Readonly<Record<string, { readonly status?: string }>>;
}

export interface MastraRuntime {
  run(
    request: MastraRunRequest,
    context?: MastraRunContext,
  ): Promise<SeqlaneRunOutcome>;
  start(request: MastraRunRequest, context?: MastraRunContext): MastraActiveRun;
  inspect(request: MastraRunRequest): Promise<MastraRuntimeInspection>;
  readonly server?: MastraRuntimeServer;
}

export interface MastraActiveRun {
  readonly outcome: Promise<SeqlaneRunOutcome>;
  cancel(): Promise<void>;
}

export interface MastraRuntimeOptions {
  /** Registers reusable workflow definitions with the Mastra server and MCP adapter. */
  readonly exposeServer?: boolean;
  /** Retrieves a typed failure captured before Mastra serializes it. */
  readonly failureForRun?: (runId: RunId) => SeqlaneError | undefined;
  /** Observes Mastra step statuses before the result is normalized. */
  readonly onWorkflowResult?: (
    request: MastraRunRequest,
    result: MastraWorkflowResult,
  ) => void;
}

export interface MastraRuntimeInspection {
  readonly workflowRun: unknown;
  readonly trace: unknown;
}

const WORK_ID_CONTEXT_KEY = "seqlane.workId";
const RUN_ID_CONTEXT_KEY = "seqlane.runId";
const TRACE_ID_LENGTH = 32;

function traceIdForRun(runId: RunId): string {
  return createHash("sha256")
    .update(runId)
    .digest("hex")
    .slice(0, TRACE_ID_LENGTH);
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

function failedOutcome(
  cause: unknown,
  typedFailure?: SeqlaneError,
): SeqlaneRunOutcome {
  if (typedFailure !== undefined) {
    return { status: "failed", error: typedFailure };
  }
  if (cause instanceof SeqlaneError) {
    return { status: "failed", error: cause };
  }
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
  result: MastraWorkflowResult,
  typedFailure?: SeqlaneError,
): SeqlaneRunOutcome {
  if (result.status === "success") {
    return {
      status: "succeeded",
      result: result.result,
    };
  }

  if (result.status === "failed") {
    return failedOutcome(result.error, typedFailure);
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
  options: MastraRuntimeOptions = {},
): MastraRuntime {
  const runtime = createMastraRuntimeCore(registrations, options);
  if (options.exposeServer === false) return runtime.runtime;

  const server = registerMastraServer(
    runtime.mastra,
    runtime.workflows,
    async ({ workflowKey, input, requestContext, abortSignal }) => {
      const registration = registrations.find(
        ({ key }) => key === workflowKey,
      );
      if (registration === undefined) {
        throw new TypeError(`Unknown Mastra workflow: "${workflowKey}"`);
      }

      const invocationRuntime = createMastraRuntimeCore(
        [registration],
        options,
      );
      const activeRun = invocationRuntime.runtime.start(
        {
          workflowKey,
          input,
          workId: `mcp-work-${randomUUID()}`,
          runId: `mcp-run-${randomUUID()}`,
        },
        { requestContext, abortSignal },
      );
      return activeRun.outcome;
    },
  );

  return { ...runtime.runtime, server };
}

function createMastraRuntimeCore(
  registrations: readonly MastraWorkflowRegistration[],
  options: MastraRuntimeOptions,
): {
  readonly mastra: Mastra;
  readonly workflows: Record<string, AnyWorkflow>;
  readonly runtime: Omit<MastraRuntime, "server">;
} {
  validateRegistrations(registrations);

  const workflows: Record<string, AnyWorkflow> = Object.fromEntries(
    registrations.map(({ key, workflow }) => [key, workflow]),
  );
  const storage = new InMemoryStore({ id: "seqlane-runtime-storage" });
  const observability = new Observability({
    configs: {
      default: {
        serviceName: "seqlane-runtime",
        exporters: [new MastraStorageExporter()],
        requestContextKeys: [WORK_ID_CONTEXT_KEY, RUN_ID_CONTEXT_KEY],
      },
    },
  });
  const mastra = new Mastra({
    workflows,
    storage,
    observability,
    logger: false,
  });
  async function flushObservability(): Promise<void> {
    await observability.flush();
  }

  let runStarted = false;

  const runtime: Omit<MastraRuntime, "server"> = {
    run(request, context) {
      return this.start(request, context).outcome;
    },
    start(request, context) {
      if (runStarted) {
        throw new TypeError(
          "A Mastra runtime instance can execute only one workflow run",
        );
      }
      runStarted = true;

      type ActiveMastraRun = Awaited<ReturnType<AnyWorkflow["createRun"]>>;
      let activeRun: ActiveMastraRun | undefined;
      let cancellationRequested = false;
      let mastraCancellationInvoked = false;
      let resolveActiveRun!: (run: ActiveMastraRun | undefined) => void;
      const activeRunReady = new Promise<ActiveMastraRun | undefined>(
        (resolve) => {
          resolveActiveRun = resolve;
        },
      );
      let cancellation: Promise<void> | undefined;
      let removeAbortListener: (() => void) | undefined;

      const requestCancellation = (): Promise<void> => {
        cancellationRequested = true;
        cancellation ??= activeRunReady.then(async (run) => {
          if (run === undefined || mastraCancellationInvoked) return;
          mastraCancellationInvoked = true;
          await run.cancel();
        });
        return cancellation;
      };

      if (context?.abortSignal !== undefined) {
        const onAbort = (): void => {
          void requestCancellation().catch(() => undefined);
        };
        if (context.abortSignal.aborted) {
          onAbort();
        } else {
          context.abortSignal.addEventListener("abort", onAbort, {
            once: true,
          });
          removeAbortListener = () =>
            context.abortSignal?.removeEventListener("abort", onAbort);
        }
      }

      const outcome = (async () => {
        try {
          const workflow = mastra.getWorkflow(request.workflowKey);
          activeRun = await workflow.createRun({
            runId: request.runId,
            resourceId: request.workId,
            shouldPersistSnapshot: () => true,
          });
          resolveActiveRun(activeRun);
          if (cancellationRequested) {
            await requestCancellation();
            return { status: "cancelled" } as const;
          }
          const requestContext = new RequestContext(
            context?.requestContext?.entries(),
          );
          requestContext.setRaw(WORK_ID_CONTEXT_KEY, request.workId);
          requestContext.setRaw(RUN_ID_CONTEXT_KEY, request.runId);
          const result = await activeRun.start({
            inputData: request.input,
            requestContext,
            tracingOptions: {
              metadata: {
                [WORK_ID_CONTEXT_KEY]: request.workId,
                [RUN_ID_CONTEXT_KEY]: request.runId,
              },
              traceId: traceIdForRun(request.runId),
            },
          });
          options.onWorkflowResult?.(request, result);
          if (cancellationRequested) {
            await requestCancellation();
            return { status: "cancelled" } as const;
          }
          return normalizeResult(
            request.workflowKey,
            result,
            options.failureForRun?.(request.runId),
          );
        } catch (cause) {
          resolveActiveRun(undefined);
          if (cancellationRequested) return { status: "cancelled" } as const;
          return failedOutcome(cause, options.failureForRun?.(request.runId));
        } finally {
          removeAbortListener?.();
          await flushObservability();
        }
      })();

      return {
        outcome,
        cancel: requestCancellation,
      };
    },
    async inspect(request) {
      const workflow = mastra.getWorkflow(request.workflowKey);
      const workflowStorage = await storage.getStore("workflows");
      const observabilityStorage = await storage.getStore("observability");
      return {
        workflowRun:
          (await workflowStorage?.getWorkflowRunById({
            runId: request.runId,
            workflowName: workflow.id,
          })) ?? null,
        trace:
          (await observabilityStorage?.getTrace({
            traceId: traceIdForRun(request.runId),
          })) ?? null,
      };
    },
  };

  return { mastra, workflows, runtime };
}
