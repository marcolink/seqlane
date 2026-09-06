import { z } from "zod";

const workflowListSchema = z.record(
  z.string(),
  z.object({ id: z.string().optional() }).passthrough(),
);

const controlResponseSchema = z.object({ message: z.string() }).passthrough();

const runResponseSchema = z
  .object({
    runId: z.string().min(1),
    workflowName: z.string().min(1).optional(),
    status: z.string().min(1),
    resourceId: z.string().min(1).optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const startAcknowledgementSchema = z
  .object({ message: z.string() })
  .passthrough();
const startResultSchema = z
  .object({
    status: z.string().min(1),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();
const startResponseSchema = z.union([
  startAcknowledgementSchema,
  startResultSchema,
]);

const terminalRunStatuses = new Set([
  "success",
  "failed",
  "canceled",
  "cancelled",
  "bailed",
  "tripwire",
  "skipped",
]);
const runLookupConcurrency = 8;
const runLookupRequestTimeoutMs = 10_000;
const initialRunObservationDelayMs = 25;
const maxRunObservationDelayMs = 1_000;
const maxConsecutiveObservationFailures = 12;

export type OperationalRun = z.output<typeof runResponseSchema>;
export type OperationalStartResult = Pick<
  OperationalRun,
  "status" | "result" | "error"
>;

export class OperationalClientError extends Error {
  readonly status: number | undefined;
  readonly timedOut: boolean;

  constructor(
    message: string,
    options: { status?: number; cause?: unknown; timedOut?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OperationalClientError";
    this.status = options.status;
    this.timedOut = options.timedOut ?? false;
  }
}

function baseUrl(value: string): string {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      url.protocol !== "http:" ||
      url.username !== "" ||
      url.password !== "" ||
      !["localhost", "127.0.0.1", "::1"].includes(hostname)
    ) {
      throw new TypeError(
        "Operational server URL must be an unauthenticated HTTP loopback URL",
      );
    }
    return url.toString().replace(/\/$/, "");
  } catch (cause) {
    throw new OperationalClientError("Operational server URL is invalid", {
      cause,
    });
  }
}

function responseError(status: number, body: unknown): OperationalClientError {
  const message =
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
      ? body.message
      : `Operational server request failed with HTTP ${status}`;
  return new OperationalClientError(message, { status });
}

function waitForObservation(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new OperationalClientError("Operational run observation was aborted", {
        cause: signal.reason,
      }),
    );
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(
        new OperationalClientError("Operational run observation was aborted", {
          cause: signal?.reason,
        }),
      );
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (cause) {
    throw new OperationalClientError(
      "Operational server returned invalid JSON",
      {
        status: response.status,
        cause,
      },
    );
  }
}

export class OperationalClient {
  readonly origin: string;

  constructor(origin: string) {
    this.origin = baseUrl(origin);
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    let timedOut = false;
    const controller =
      timeoutMs === undefined ? undefined : new AbortController();
    const timeout =
      controller === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
    const requestSignal =
      controller === undefined
        ? signal
        : signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, signal]);
    try {
      response = await fetch(`${this.origin}${path}`, {
        ...init,
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
      });
    } catch (cause) {
      if (signal?.aborted && !timedOut) {
        throw new OperationalClientError(
          "Operational run observation was aborted",
          { cause: signal.reason },
        );
      }
      throw new OperationalClientError(
        timedOut
          ? "Operational server request timed out"
          : "Could not reach operational server",
        { cause, timedOut },
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    const body = await readBody(response);
    if (!response.ok) throw responseError(response.status, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new OperationalClientError(
        "Operational server returned an invalid response",
        { status: response.status, cause: parsed.error },
      );
    }
    return parsed.data;
  }

  async listWorkflows(signal?: AbortSignal): Promise<readonly string[]> {
    const workflows = await this.request(
      "/api/workflows",
      { method: "GET" },
      workflowListSchema,
      undefined,
      signal,
    );
    return Object.keys(workflows).sort();
  }

  async resolveWorkflow(
    workflowId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const workflows = await this.request(
      "/api/workflows",
      { method: "GET" },
      workflowListSchema,
      undefined,
      signal,
    );
    if (workflows[workflowId] !== undefined) return workflowId;
    const match = Object.entries(workflows).find(
      ([, workflow]) => workflow.id === workflowId,
    );
    if (match !== undefined) return match[0];
    throw new OperationalClientError(
      `Workflow "${workflowId}" is not registered with the operational server`,
      { status: 404 },
    );
  }

  async startRun(options: {
    readonly workflowId: string;
    readonly runId: string;
    readonly workId: string;
    readonly input: unknown;
    readonly runtimeId?: string;
    readonly workspace?: string;
    readonly signal?: AbortSignal;
  }): Promise<OperationalStartResult> {
    const resolvedWorkflow = await this.resolveWorkflow(
      options.workflowId,
      options.signal,
    );
    const workflowId = encodeURIComponent(resolvedWorkflow);
    const query = new URLSearchParams({ runId: options.runId });
    const body = {
      resourceId: options.workId,
      inputData: options.input,
      requestContext: {
        "seqlane.workId": options.workId,
        "seqlane.runId": options.runId,
        ...(options.runtimeId === undefined
          ? {}
          : { "seqlane.runtimeId": options.runtimeId }),
        ...(options.workspace === undefined
          ? {}
          : { "seqlane.workspace": options.workspace }),
      },
      tracingOptions: {
        metadata: {
          "seqlane.workId": options.workId,
          "seqlane.runId": options.runId,
        },
        traceId: options.runId.replaceAll("-", "").padEnd(32, "0").slice(0, 32),
      },
    };
    const startResponse = await this.request(
      `/api/workflows/${workflowId}/start-async?${query.toString()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      startResponseSchema,
      undefined,
      options.signal,
    );

    if (
      "status" in startResponse &&
      typeof startResponse.status === "string" &&
      terminalRunStatuses.has(startResponse.status)
    ) {
      return {
        status: startResponse.status,
        ...(startResponse.result === undefined
          ? {}
          : { result: startResponse.result }),
        ...(startResponse.error === undefined
          ? {}
          : { error: startResponse.error }),
      };
    }

    let observationDelayMs = initialRunObservationDelayMs;
    let consecutiveObservationFailures = 0;
    while (true) {
      try {
        const run = await this.getRunForWorkflow(
          options.runId,
          resolvedWorkflow,
          options.signal,
        );
        if (terminalRunStatuses.has(run.status)) return startResultFromRun(run);
        // A visible non-terminal run is healthy evidence that observation is
        // working, so a legitimately long-running execution is unbounded.
        consecutiveObservationFailures = 0;
      } catch (error) {
        if (error instanceof OperationalClientError && error.status === 404) {
          // The run record can become visible after the async start response.
          consecutiveObservationFailures += 1;
        } else if (!(
          error instanceof OperationalClientError && error.timedOut
        )) {
          throw error;
        } else {
          consecutiveObservationFailures += 1;
        }
        if (
          consecutiveObservationFailures >= maxConsecutiveObservationFailures
        ) {
          const timedOut =
            error instanceof OperationalClientError && error.timedOut;
          throw new OperationalClientError(
            timedOut
              ? `Operational run "${options.runId}" could not be observed after ${maxConsecutiveObservationFailures} timed-out requests`
              : `Operational run "${options.runId}" remained unavailable after ${maxConsecutiveObservationFailures} observations`,
            {
              status: timedOut ? undefined : 404,
              timedOut,
              cause: error,
            },
          );
        }
      }
      await waitForObservation(observationDelayMs, options.signal);
      observationDelayMs = Math.min(
        observationDelayMs * 2,
        maxRunObservationDelayMs,
      );
    }
  }

  async getRun(runId: string, workflowId?: string): Promise<OperationalRun> {
    const target = await this.findRun(runId, workflowId);
    return target.run;
  }

  private async getRunForWorkflow(
    runId: string,
    workflow: string,
    signal?: AbortSignal,
  ): Promise<OperationalRun> {
    return this.request(
      `/api/workflows/${encodeURIComponent(workflow)}/runs/${encodeURIComponent(runId)}`,
      { method: "GET" },
      runResponseSchema,
      runLookupRequestTimeoutMs,
      signal,
    );
  }

  private async findRun(
    runId: string,
    workflowId?: string,
  ): Promise<{ readonly run: OperationalRun; readonly workflow: string }> {
    const candidates = workflowId
      ? [await this.resolveWorkflow(workflowId)]
      : await this.listWorkflows();
    let lastNotFound: OperationalClientError | undefined;
    for (
      let offset = 0;
      offset < candidates.length;
      offset += runLookupConcurrency
    ) {
      const batch = candidates.slice(offset, offset + runLookupConcurrency);
      const outcomes = await Promise.all(
        batch.map(async (candidate) => {
          try {
            return {
              run: await this.getRunForWorkflow(runId, candidate),
              workflow: candidate,
            };
          } catch (error) {
            if (
              error instanceof OperationalClientError &&
              error.status === 404
            ) {
              return { error };
            }
            throw error;
          }
        }),
      );
      for (const outcome of outcomes) {
        if ("error" in outcome) {
          lastNotFound = outcome.error;
        } else {
          return outcome;
        }
      }
    }
    throw (
      lastNotFound ??
      new OperationalClientError(`Run "${runId}" was not found`, {
        status: 404,
      })
    );
  }

  async cancelRun(runId: string, workflowId?: string): Promise<string> {
    const target = await this.findRun(runId, workflowId);
    const workflow = encodeURIComponent(target.workflow);
    const response = await this.request(
      `/api/workflows/${workflow}/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      controlResponseSchema,
    );
    return response.message;
  }
}

function startResultFromRun(run: OperationalRun): OperationalStartResult {
  return {
    status: run.status,
    ...(run.result === undefined ? {} : { result: run.result }),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}
