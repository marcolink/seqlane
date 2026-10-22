import {
  operationalHealthSchema,
  operationalReadinessSchema,
  operationalRunCancelRequestSchema,
  operationalRunCancelSchema,
  operationalRunEventsRequestSchema,
  operationalRunEventsSchema,
  operationalRunListRequestSchema,
  operationalRunListSchema,
  operationalRunReferenceSchema,
  operationalRunStartRequestSchema,
  operationalRunStatusSchema,
  operationalTraceInspectionSchema,
  operationalWorkflowDetailSchema,
  operationalWorkflowListSchema,
  serializedSeqlaneErrorSchema,
  type OperationalHealth,
  type OperationalReadiness,
  type OperationalRunCancel,
  type OperationalRunEvents,
  type OperationalRunList,
  type OperationalRunStatus,
  type OperationalTraceInspection,
  type OperationalWorkflow,
} from "@seqlane/protocol";
import { Cause, Duration, Effect, Exit, Result, Schedule } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpBody from "effect/http/HttpBody";
import * as Stream from "effect/Stream";
import type { z } from "zod";

const runObservationRequestTimeoutMs = 10_000;
const initialRunObservationDelayMs = 25;
const maxRunObservationDelayMs = 1_000;
const maxConsecutiveObservationFailures = 12;
const maxResponseBytes = 32 * 1024 * 1024;
const defaultRequestTimeoutMs = 10_000;

export type OperationalRun = OperationalRunStatus;
export type OperationalStartResult = Pick<
  OperationalRunStatus,
  "status" | "output" | "error" | "completeness"
>;

type OperationalClientEffect<A> = Effect.Effect<
  A,
  unknown,
  HttpClient.HttpClient
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

export function parseOperationalServerUrl(value: string): URL {
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
    return url;
  } catch (cause) {
    throw new OperationalClientError("Operational server URL is invalid", {
      cause,
    });
  }
}

function baseUrl(value: string): string {
  return parseOperationalServerUrl(value).toString().replace(/\/$/, "");
}

function urlPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function responseError(status: number, body: unknown): OperationalClientError {
  const serializedError = serializedSeqlaneErrorSchema.safeParse(body);
  return new OperationalClientError(
    serializedError.success
      ? serializedError.data.message
      : `Operational server request failed with HTTP ${status}`,
    { status, cause: body },
  );
}

function responseJson(
  response: import("effect/http/HttpClientResponse").HttpClientResponse,
): OperationalClientEffect<unknown> {
  return Stream.runFoldEffect(
    response.stream,
    (): { readonly chunks: Uint8Array[]; readonly bytes: number } => ({
      chunks: [],
      bytes: 0,
    }),
    (state, chunk) => {
      const bytes = state.bytes + chunk.byteLength;
      if (bytes > maxResponseBytes) {
        return Effect.fail(
          new OperationalClientError(
            "Operational server response is too large",
            {
              status: response.status,
            },
          ),
        );
      }
      state.chunks.push(chunk);
      return Effect.succeed({ chunks: state.chunks, bytes });
    },
  ).pipe(
    Effect.flatMap(({ chunks, bytes }) =>
      Effect.try({
        try: () => {
          const body = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
          const parsed: unknown = JSON.parse(text);
          return parsed;
        },
        catch: (cause) =>
          new OperationalClientError(
            "Operational server returned invalid JSON",
            { status: response.status, cause },
          ),
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof OperationalClientError
        ? cause
        : new OperationalClientError(
            "Operational server response could not be read",
            { status: response.status, cause },
          ),
    ),
  );
}

function transportRequest<T>(
  origin: string,
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  timeoutMs?: number,
): OperationalClientEffect<T> {
  return Effect.scoped(
    Effect.gen(function* () {
      const rawRequest = HttpClientRequest.make(
        init.method === "POST" ? "POST" : "GET",
      )(`${origin}${urlPath(path)}`);
      const request =
        init.body === undefined
          ? rawRequest
          : rawRequest.pipe(
              HttpClientRequest.setBody(
                HttpBody.text(String(init.body), "application/json"),
              ),
            );
      const response = yield* HttpClient.withScope(
        yield* HttpClient.HttpClient,
      ).execute(request);
      if (response.status < 200 || response.status >= 300) {
        const errorBody = yield* Effect.result(responseJson(response));
        if (Result.isSuccess(errorBody)) {
          return yield* Effect.fail(
            responseError(response.status, errorBody.success),
          );
        }
        return yield* Effect.fail(
          new OperationalClientError(
            `Operational server request failed with HTTP ${response.status}`,
            { status: response.status, cause: errorBody.failure },
          ),
        );
      }
      const body = yield* responseJson(response);
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return yield* Effect.fail(
          new OperationalClientError(
            "Operational server returned an invalid response",
            { status: response.status, cause: parsed.error },
          ),
        );
      }
      return parsed.data;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs ?? defaultRequestTimeoutMs),
      orElse: () =>
        Effect.fail(
          new OperationalClientError("Operational server request timed out", {
            timedOut: true,
          }),
        ),
    }),
  );
}

function workflowKeyEffect(
  origin: string,
  workflowId: string,
): OperationalClientEffect<string> {
  return Effect.gen(function* () {
    const response = yield* transportRequest(
      origin,
      "/api/workflows",
      { method: "GET" },
      operationalWorkflowListSchema,
    );
    const match = response.workflows.find(
      (workflow) => workflow.key === workflowId || workflow.id === workflowId,
    );
    if (match !== undefined) return match.key;
    return yield* Effect.fail(
      new OperationalClientError(
        `Workflow "${workflowId}" is not registered with the operational server`,
        { status: 404 },
      ),
    );
  });
}

function terminalResult(run: OperationalRunStatus): OperationalStartResult {
  return {
    status: run.status,
    ...(run.output === undefined ? {} : { output: run.output }),
    ...(run.error === undefined ? {} : { error: run.error }),
    completeness: run.completeness,
  };
}

function startRunEffect(
  origin: string,
  options: {
    readonly workflowId: string;
    readonly runId: string;
    readonly workId: string;
    readonly input: unknown;
    readonly runtimeId?: string;
    readonly workspace?: string;
  },
): OperationalClientEffect<OperationalStartResult> {
  return Effect.gen(function* () {
    const workflowKey = yield* workflowKeyEffect(origin, options.workflowId);
    const request = operationalRunStartRequestSchema.safeParse({
      version: 1,
      workId: options.workId,
      runId: options.runId,
      input: options.input,
      ...(options.runtimeId === undefined
        ? {}
        : {
            runtime: {
              id: options.runtimeId,
              ...(options.workspace === undefined
                ? {}
                : { workspace: options.workspace }),
            },
          }),
    });
    if (!request.success) {
      return yield* Effect.fail(
        new OperationalClientError("Operational run request is invalid", {
          cause: request.error,
        }),
      );
    }
    const reference = yield* transportRequest(
      origin,
      `/api/workflows/${encodeURIComponent(workflowKey)}/start-async`,
      jsonRequest("POST", request.data),
      operationalRunReferenceSchema,
    );

    let consecutiveFailures = 0;
    const delaySchedule = Schedule.exponential(
      Duration.millis(initialRunObservationDelayMs),
      2,
    ).pipe(
      Schedule.modifyDelay(({ duration }) =>
        Effect.succeed(
          Duration.min(duration, Duration.millis(maxRunObservationDelayMs)),
        ),
      ),
    );
    const waitForNextObservation =
      yield* Schedule.toStepWithSleep(delaySchedule);
    while (true) {
      const observation = yield* Effect.result(
        transportRequest(
          origin,
          `/api/workflows/${encodeURIComponent(workflowKey)}/runs/${encodeURIComponent(reference.runId)}`,
          { method: "GET" },
          operationalRunStatusSchema,
          runObservationRequestTimeoutMs,
        ),
      );
      if (Result.isSuccess(observation)) {
        const run = observation.success;
        if (
          ["succeeded", "failed", "cancelled", "interrupted"].includes(
            run.status,
          )
        ) {
          return terminalResult(run);
        }
        consecutiveFailures = 0;
      } else {
        const error = observation.failure;
        if (
          error instanceof OperationalClientError &&
          (error.status === 404 || error.timedOut)
        ) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= maxConsecutiveObservationFailures) {
            return yield* Effect.fail(
              new OperationalClientError(
                `Operational run "${reference.runId}" remained unavailable after ${maxConsecutiveObservationFailures} observations`,
                {
                  status: error.status,
                  timedOut: error.timedOut,
                  cause: error,
                },
              ),
            );
          }
        } else {
          return yield* Effect.fail(error);
        }
      }
      yield* waitForNextObservation("poll");
    }
  });
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export class OperationalClient {
  readonly origin: string;

  constructor(origin: string) {
    this.origin = baseUrl(origin);
  }

  private evaluate<T>(
    effect: Effect.Effect<T, unknown, HttpClient.HttpClient>,
    signal?: AbortSignal,
  ): Promise<T> {
    return Effect.runPromiseExit(
      effect.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "error",
        }),
      ),
      signal === undefined ? undefined : { signal },
    ).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      const cause = Cause.squash(exit.cause);
      if (cause instanceof OperationalClientError) throw cause;
      if (signal?.aborted) {
        throw new OperationalClientError(
          "Operational run observation was aborted",
          { cause: signal.reason ?? cause },
        );
      }
      throw new OperationalClientError("Could not reach operational server", {
        cause,
      });
    });
  }

  private request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.evaluate(
      transportRequest(this.origin, path, init, schema, timeoutMs),
      signal,
    );
  }

  async health(signal?: AbortSignal): Promise<OperationalHealth> {
    return this.request(
      "/healthz",
      { method: "GET" },
      operationalHealthSchema,
      undefined,
      signal,
    );
  }

  async readiness(signal?: AbortSignal): Promise<OperationalReadiness> {
    return this.request(
      "/readyz",
      { method: "GET" },
      operationalReadinessSchema,
      undefined,
      signal,
    );
  }

  async listWorkflows(
    signal?: AbortSignal,
  ): Promise<readonly OperationalWorkflow[]> {
    const response = await this.request(
      "/api/workflows",
      { method: "GET" },
      operationalWorkflowListSchema,
      undefined,
      signal,
    );
    return response.workflows;
  }

  async getWorkflow(
    workflowId: string,
    signal?: AbortSignal,
  ): Promise<OperationalWorkflow> {
    const response = await this.request(
      `/api/workflows/${encodeURIComponent(workflowId)}`,
      { method: "GET" },
      operationalWorkflowDetailSchema,
      undefined,
      signal,
    );
    return response.workflow;
  }

  async resolveWorkflow(
    workflowId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.evaluate(workflowKeyEffect(this.origin, workflowId), signal);
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
    return this.evaluate(startRunEffect(this.origin, options), options.signal);
  }

  async getRun(
    runId: string,
    signal?: AbortSignal,
  ): Promise<OperationalRunStatus> {
    return this.request(
      `/api/runs/${encodeURIComponent(runId)}`,
      { method: "GET" },
      operationalRunStatusSchema,
      undefined,
      signal,
    );
  }

  async listRuns(
    options: { readonly limit?: number; readonly cursor?: number } = {},
    signal?: AbortSignal,
  ): Promise<OperationalRunList> {
    const query = new URLSearchParams({
      version: "1",
      limit: String(options.limit ?? 50),
    });
    if (options.cursor !== undefined)
      query.set("cursor", String(options.cursor));
    const validated = operationalRunListRequestSchema.parse({
      version: 1,
      ...options,
    });
    query.set("limit", String(validated.limit));
    if (validated.cursor !== undefined)
      query.set("cursor", String(validated.cursor));
    return this.request(
      `/api/runs?${query}`,
      { method: "GET" },
      operationalRunListSchema,
      undefined,
      signal,
    );
  }

  async getRunEvents(
    runId: string,
    options: { readonly afterSequence?: number; readonly limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<OperationalRunEvents> {
    const validated = operationalRunEventsRequestSchema.parse({
      version: 1,
      ...options,
    });
    const query = new URLSearchParams({
      version: "1",
      afterSequence: String(validated.afterSequence),
      limit: String(validated.limit),
    });
    return this.request(
      `/api/runs/${encodeURIComponent(runId)}/events?${query}`,
      { method: "GET" },
      operationalRunEventsSchema,
      undefined,
      signal,
    );
  }

  async cancelRun(
    runId: string,
    workflowId?: string,
    signal?: AbortSignal,
  ): Promise<OperationalRunCancel> {
    const resolvedRunId = operationalRunCancelRequestSchema.parse({
      version: 1,
      runId,
    });
    const path =
      workflowId === undefined
        ? `/api/runs/${encodeURIComponent(runId)}/cancel`
        : `/api/workflows/${encodeURIComponent(await this.resolveWorkflow(workflowId, signal))}/runs/${encodeURIComponent(runId)}/cancel`;
    return this.request(
      path,
      jsonRequest("POST", resolvedRunId),
      operationalRunCancelSchema,
      undefined,
      signal,
    );
  }

  async getTrace(
    runId: string,
    signal?: AbortSignal,
  ): Promise<OperationalTraceInspection> {
    return this.request(
      `/api/runs/${encodeURIComponent(runId)}/trace`,
      { method: "GET" },
      operationalTraceInspectionSchema,
      undefined,
      signal,
    );
  }
}
