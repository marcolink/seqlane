import { createServer } from "node:http";
import {
  ByteSize,
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Stream,
} from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  operationalHealthSchema,
  operationalReadinessSchema,
  operationalRunCancelRequestSchema,
  operationalRunCancelSchema,
  operationalRunEventsRequestSchema,
  operationalRunEventsSchema,
  operationalRunListRequestSchema,
  operationalRunListSchema,
  operationalRunStartRequestSchema,
  operationalRunStatusSchema,
  operationalTraceInspectionSchema,
  operationalWorkflowDetailSchema,
  operationalWorkflowListSchema,
  serializeSeqlaneError,
} from "@seqlane/protocol";
import type { OperationalHost, OperationalHostOptions } from "./types.js";
import {
  OperationalRunConflictError,
  OperationalStorageError,
  OperationalStorageVersionError,
  openOperationalStore,
} from "./sqlite-store.js";
import {
  createOperationalRunManager,
  OperationalAdmissionError,
  OperationalNotFoundError,
} from "./run-manager.js";
import { operationalMcpLayer } from "./mcp.js";
import { z } from "zod";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4111;
const MAX_BODY_BYTES = 1024 * 1024;
const BODY_DEADLINE_MS = 10_000;

class RequestBodyTooLargeError extends Error {}
class RequestValidationError extends Error {}
class RequestDeadlineError extends Error {}
class OperationalNotReadyError extends Error {}

function safeLoopback(host: string): string {
  if (host === "localhost" || host === "127.0.0.1") return host;
  if (host === "::1" || host === "[::1]") return "::1";
  throw new TypeError(
    "Operational host must bind to localhost, 127.0.0.1, or ::1",
  );
}

function validateOptions(options: OperationalHostOptions): {
  host: string;
  port: number;
} {
  if (options.workflows.length === 0)
    throw new TypeError("At least one workflow must be registered");
  const keys = new Set<string>();
  for (const workflow of options.workflows) {
    if (keys.has(workflow.key))
      throw new TypeError(
        `Duplicate operational workflow key: ${workflow.key}`,
      );
    keys.add(workflow.key);
  }
  const host = safeLoopback(options.host ?? DEFAULT_HOST);
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new TypeError(
      "Operational host port must be an integer from 0 to 65535",
    );
  return { host, port };
}

function json(value: unknown, status = 200) {
  return HttpServerResponse.jsonUnsafe(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function statusForError(cause: unknown) {
  if (cause instanceof OperationalNotFoundError) return 404;
  if (cause instanceof OperationalAdmissionError) return 429;
  if (cause instanceof OperationalRunConflictError) return 409;
  if (cause instanceof RequestBodyTooLargeError) return 413;
  if (cause instanceof RequestDeadlineError) return 408;
  if (
    cause instanceof RequestValidationError ||
    cause instanceof SyntaxError ||
    cause instanceof TypeError ||
    cause instanceof URIError ||
    cause instanceof z.ZodError
  )
    return 400;
  if (
    cause instanceof OperationalStorageError ||
    cause instanceof OperationalStorageVersionError ||
    cause instanceof OperationalNotReadyError
  )
    return 503;
  return 500;
}

function errorResponse(cause: unknown) {
  const status = statusForError(cause);
  return json(
    serializeSeqlaneError(
      cause instanceof Error
        ? cause
        : new Error("Operational request failed", { cause }),
    ),
    status,
  );
}

type ServerRequest = HttpServerRequest.HttpServerRequest;

function requestUrl(request: ServerRequest): URL {
  return new URL(request.url, "http://localhost");
}

function requestAllowed(
  request: ServerRequest,
  host: string,
  getPort: () => number,
): void {
  requestAllowedHeaders(
    { host: request.headers.host, origin: request.headers.origin },
    requestUrl(request).hostname,
    host,
    getPort(),
  );
}

function requestAllowedHeaders(
  headers: { readonly host?: string; readonly origin?: string },
  requestHost: string,
  host: string,
  port: number,
): void {
  const authority = headers.host;
  if (authority !== undefined) {
    const accepted = new Set([
      `${host}:${port}`,
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
      ...(port === 80 ? [host, "localhost", "127.0.0.1", "[::1]"] : []),
    ]);
    if (!accepted.has(authority.toLowerCase()))
      throw new RequestValidationError("Unexpected Host header");
  }
  const origin = headers.origin;
  if (origin === undefined) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new RequestValidationError("Invalid Origin header");
  }
  const localHost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  const canonical =
    parsed.origin === origin &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "";
  if (
    !canonical ||
    parsed.protocol !== "http:" ||
    !localHost ||
    (parsed.port || "80") !== String(port)
  )
    throw new RequestValidationError(
      "Origin must match the operational host origin",
    );
  const normalizedRequestHost =
    requestHost.startsWith("[") && requestHost.endsWith("]")
      ? requestHost.slice(1, -1)
      : requestHost;
  if (
    normalizedRequestHost !== "localhost" &&
    normalizedRequestHost !== "127.0.0.1" &&
    normalizedRequestHost !== "::1"
  )
    throw new RequestValidationError("Request host must be loopback");
}

function boundedBodyBytes(stream: Stream.Stream<Uint8Array, unknown>) {
  return Stream.runFold(
    stream,
    () => ({ chunks: [] as Uint8Array[], bytes: 0, tooLarge: false }),
    (state, chunk) => {
      if (state.tooLarge || state.bytes + chunk.byteLength > MAX_BODY_BYTES) {
        return { ...state, tooLarge: true };
      }
      state.chunks.push(chunk);
      return { ...state, bytes: state.bytes + chunk.byteLength };
    },
  ).pipe(
    Effect.timeoutOrElse({
      duration: BODY_DEADLINE_MS,
      orElse: () =>
        Effect.fail(new RequestDeadlineError("Request body deadline exceeded")),
    }),
    Effect.map(({ chunks, bytes, tooLarge }) => {
      if (tooLarge)
        throw new RequestBodyTooLargeError("Request body exceeds hosted limit");
      const input = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        input.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return input;
    }),
  );
}

function bodyJson(request: ServerRequest): Effect.Effect<unknown, unknown> {
  return boundedBodyBytes(request.stream).pipe(
    Effect.map((input) => {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
      return JSON.parse(text) as unknown;
    }),
  );
}

function queryObject(url: URL): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(result, key))
      throw new RequestValidationError(`Duplicate query parameter: ${key}`);
    result[key] = value;
  }
  return result;
}

function numericQuery(url: URL, keys: readonly string[]) {
  const raw = queryObject(url);
  for (const key of keys)
    if (typeof raw[key] === "string") raw[key] = Number(raw[key]);
  return raw;
}

function parseListQuery(url: URL) {
  return operationalRunListRequestSchema.parse(
    numericQuery(url, ["version", "limit", "cursor"]),
  );
}

function parseEventsQuery(url: URL) {
  return operationalRunEventsRequestSchema.parse(
    numericQuery(url, ["version", "afterSequence", "limit"]),
  );
}

function route<E>(
  f: (request: ServerRequest) => Effect.Effect<unknown, E>,
  host: string,
  getPort: () => number,
) {
  return (request: ServerRequest) =>
    Effect.try({
      try: () => requestAllowed(request, host, getPort),
      catch: (cause) => cause,
    }).pipe(
      Effect.andThen(Effect.suspend(() => f(request))),
      Effect.map(json),
      Effect.catchCause((cause) =>
        Effect.succeed(errorResponse(Cause.squash(cause))),
      ),
    );
}

function hostRequestPolicy(host: string, getPort: () => number) {
  return HttpRouter.middleware(
    (httpEffect) =>
      Effect.withFiber((fiber) => {
        const request = Context.getUnsafe(
          fiber.context,
          HttpServerRequest.HttpServerRequest,
        );
        const boundedRequest = new Proxy(request, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (
              (property === "text" ||
                property === "arrayBuffer" ||
                property === "json") &&
              Effect.isEffect(value)
            )
              return value.pipe(
                Effect.timeoutOrElse({
                  duration: BODY_DEADLINE_MS,
                  orElse: () =>
                    Effect.fail(
                      new RequestDeadlineError(
                        "Request body deadline exceeded",
                      ),
                    ),
                }),
              );
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return Effect.sync(() => requestAllowed(request, host, getPort)).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Exit.isFailure(exit)
              ? Effect.succeed(errorResponse(Cause.squash(exit.cause)))
              : httpEffect,
          ),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            boundedRequest,
          ),
          Effect.provideService(
            HttpServerRequest.MaxBodySize,
            ByteSize.fromInputUnsafe(MAX_BODY_BYTES),
          ),
        );
      }),
    { global: true },
  );
}

function routes(
  manager: ReturnType<typeof createOperationalRunManager>,
  host: string,
  getPort: () => number,
  isReady: () => boolean,
) {
  const workflow = (key: string) => {
    const found = manager.workflows.find((item) => item.key === key);
    if (found === undefined) throw new OperationalNotFoundError("workflow");
    return found;
  };
  const pathParts = (request: ServerRequest) =>
    requestUrl(request)
      .pathname.split("/")
      .filter((part) => part.length > 0)
      .map(decodeURIComponent);
  const runId = (request: ServerRequest) => {
    const parts = pathParts(request);
    const runsIndex = parts.lastIndexOf("runs");
    const id = parts[runsIndex + 1];
    if (runsIndex < 0 || id === undefined)
      throw new OperationalNotFoundError("run");
    return id;
  };
  const add = (
    method: "GET" | "POST",
    path: `/${string}`,
    handler: (request: ServerRequest) => Effect.Effect<unknown, unknown>,
  ) => HttpRouter.add(method, path, route(handler, host, getPort));
  const listWorkflows = () =>
    Effect.succeed(
      operationalWorkflowListSchema.parse({
        version: 1,
        workflows: manager.workflows,
      }),
    );
  return Layer.mergeAll(
    add("GET", "/", () =>
      Effect.succeed({ service: "seqlane-operations", version: 1 }),
    ),
    add("GET", "/healthz", () =>
      Effect.succeed(
        operationalHealthSchema.parse({ version: 1, status: "ok" }),
      ),
    ),
    add("GET", "/readyz", () =>
      isReady()
        ? Effect.succeed(
            operationalReadinessSchema.parse({
              version: 1,
              status: "ready",
              checks: [{ id: "storage", status: "ready" }],
            }),
          )
        : Effect.fail(
            new OperationalNotReadyError("Operational host is not ready"),
          ),
    ),
    add("GET", "/api/workflows", listWorkflows),
    add("GET", "/api/workflows/list", listWorkflows),
    add("GET", "/api/workflows/:key", (request) => {
      const key = pathParts(request).at(-1) ?? "";
      return Effect.succeed(
        operationalWorkflowDetailSchema.parse({
          version: 1,
          workflow: workflow(key),
        }),
      );
    }),
    add("POST", "/api/workflows/:key/start-async", (request) =>
      Effect.gen(function* () {
        const key = pathParts(request).at(-2) ?? "";
        workflow(key);
        const body = operationalRunStartRequestSchema.parse(
          yield* bodyJson(request),
        );
        return yield* Effect.tryPromise({
          try: () => manager.start(key, body),
          catch: (cause) => cause,
        });
      }),
    ),
    add("GET", "/api/runs/list", (request) =>
      Effect.tryPromise({
        try: () => manager.list(parseListQuery(requestUrl(request))),
        catch: (cause) => cause,
      }),
    ),
    add("GET", "/api/runs", (request) =>
      Effect.tryPromise({
        try: () => manager.list(parseListQuery(requestUrl(request))),
        catch: (cause) => cause,
      }),
    ),
    add("GET", "/api/workflows/:key/runs", (request) =>
      Effect.gen(function* () {
        const key = pathParts(request).at(-2) ?? "";
        workflow(key);
        const page = yield* Effect.tryPromise({
          try: () => manager.list(parseListQuery(requestUrl(request))),
          catch: (cause) => cause,
        });
        return operationalRunListSchema.parse({
          ...page,
          runs: page.runs.filter((run) => run.workflowKey === key),
        });
      }),
    ),
    add("GET", "/api/runs/:id/status", (request) =>
      Effect.tryPromise({
        try: async () =>
          operationalRunStatusSchema.parse(
            await manager.status(runId(request)),
          ),
        catch: (cause) => cause,
      }),
    ),
    add("GET", "/api/runs/:id/result", (request) =>
      Effect.tryPromise({
        try: async () =>
          operationalRunStatusSchema.parse(
            await manager.status(runId(request)),
          ),
        catch: (cause) => cause,
      }),
    ),
    add("GET", "/api/runs/:id", (request) =>
      Effect.tryPromise({
        try: async () =>
          operationalRunStatusSchema.parse(
            await manager.status(runId(request)),
          ),
        catch: (cause) => cause,
      }),
    ),
    add("GET", "/api/workflows/:key/runs/:id/status", (request) =>
      Effect.tryPromise({
        try: async () => {
          const key = pathParts(request).at(-4) ?? "";
          const status = operationalRunStatusSchema.parse(
            await manager.status(runId(request)),
          );
          if (status.workflowKey !== key)
            throw new OperationalNotFoundError("run");
          return status;
        },
        catch: (cause) => cause,
      }),
    ),
    add("GET", "/api/workflows/:key/runs/:id", (request) =>
      Effect.tryPromise({
        try: async () => {
          const key = pathParts(request).at(-3) ?? "";
          const status = operationalRunStatusSchema.parse(
            await manager.status(runId(request)),
          );
          if (status.workflowKey !== key)
            throw new OperationalNotFoundError("run");
          return status;
        },
        catch: (cause) => cause,
      }),
    ),
    add("GET", "/api/workflows/:key/runs/:id/result", (request) =>
      Effect.tryPromise({
        try: async () => {
          const key = pathParts(request).at(-4) ?? "";
          const status = operationalRunStatusSchema.parse(
            await manager.status(runId(request)),
          );
          if (status.workflowKey !== key)
            throw new OperationalNotFoundError("run");
          return status;
        },
        catch: (cause) => cause,
      }),
    ),
    add("GET", "/api/runs/:id/events", (request) =>
      Effect.tryPromise({
        try: async () =>
          operationalRunEventsSchema.parse(
            await manager.events(
              runId(request),
              parseEventsQuery(requestUrl(request)),
            ),
          ),
        catch: (cause) => cause,
      }),
    ),
    add("GET", "/api/workflows/:key/runs/:id/events", (request) =>
      Effect.tryPromise({
        try: async () => {
          const key = pathParts(request).at(-4) ?? "";
          const id = runId(request);
          const events = operationalRunEventsSchema.parse(
            await manager.events(id, parseEventsQuery(requestUrl(request))),
          );
          if ((await manager.status(id)).workflowKey !== key)
            throw new OperationalNotFoundError("run");
          return events;
        },
        catch: (cause) => cause,
      }),
    ),
    add("GET", "/api/runs/:id/trace", (request) =>
      Effect.tryPromise({
        try: async () =>
          operationalTraceInspectionSchema.parse(
            await manager.trace(runId(request)),
          ),
        catch: (cause) => cause,
      }),
    ),
    add("GET", "/api/workflows/:key/runs/:id/trace", (request) =>
      Effect.tryPromise({
        try: async () => {
          const key = pathParts(request).at(-4) ?? "";
          const id = runId(request);
          const trace = operationalTraceInspectionSchema.parse(
            await manager.trace(id),
          );
          if ((await manager.status(id)).workflowKey !== key)
            throw new OperationalNotFoundError("run");
          return trace;
        },
        catch: (cause) => cause,
      }),
    ),
    add("POST", "/api/runs/:id/cancel", (request) =>
      Effect.gen(function* () {
        const id = runId(request);
        const body = operationalRunCancelRequestSchema.parse(
          yield* bodyJson(request),
        );
        if (body.runId !== id)
          throw new RequestValidationError("Cancel body runId must match path");
        return yield* Effect.tryPromise({
          try: async () =>
            operationalRunCancelSchema.parse(await manager.cancel(id)),
          catch: (cause) => cause,
        });
      }),
    ),
    add("POST", "/api/workflows/:key/runs/:id/cancel", (request) =>
      Effect.gen(function* () {
        const key = pathParts(request).at(-4) ?? "";
        const id = runId(request);
        const current = yield* Effect.tryPromise({
          try: () => manager.status(id),
          catch: (cause) => cause,
        });
        if (current.workflowKey !== key)
          throw new OperationalNotFoundError("run");
        const body = operationalRunCancelRequestSchema.parse(
          yield* bodyJson(request),
        );
        if (body.runId !== id)
          throw new RequestValidationError("Cancel body runId must match path");
        return yield* Effect.tryPromise({
          try: async () =>
            operationalRunCancelSchema.parse(await manager.cancel(id)),
          catch: (cause) => cause,
        });
      }),
    ),
  ).pipe(Layer.provide(HttpRouter.layer));
}

async function boundedFetchRequest(
  request: globalThis.Request,
): Promise<globalThis.Request> {
  const body = request.body;
  if (body === null) return request;
  const bodyStream = Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => cause,
  });
  const bodyExit = await Effect.runPromiseExit(boundedBodyBytes(bodyStream), {
    signal: request.signal,
  });
  if (Exit.isFailure(bodyExit)) throw Cause.squash(bodyExit.cause);
  const bytes = bodyExit.value;
  return new globalThis.Request(request.url, {
    method: request.method,
    headers: request.headers,
    body:
      request.method === "GET" || request.method === "HEAD" ? undefined : bytes,
    signal: request.signal,
  });
}

export async function createNativeOperationalHost(
  options: OperationalHostOptions,
): Promise<OperationalHost> {
  const validated = validateOptions(options);
  const store = await openOperationalStore(options.storageUrl);
  let manager: ReturnType<typeof createOperationalRunManager>;
  try {
    manager = createOperationalRunManager({
      workflows: options.workflows,
      store,
      classifierConnection: options.classifierConnection,
      telemetryConfiguration: options.telemetryConfiguration,
    });
  } catch (cause) {
    try {
      await store.close();
    } catch {
      /* Preserve the host-construction failure. */
    }
    throw cause;
  }
  let listeningPort = validated.port;
  let ready = false;
  const getPort = () => listeningPort;
  const allowedOrigins: string[] = [];
  const refreshAllowedOrigins = () => {
    allowedOrigins.splice(
      0,
      allowedOrigins.length,
      ...["localhost", "127.0.0.1", "[::1]"].map(
        (hostname) => `http://${hostname}:${listeningPort}`,
      ),
    );
  };
  refreshAllowedOrigins();
  const webApp = Layer.mergeAll(
    routes(manager, validated.host, getPort, () => ready && store.healthy),
    operationalMcpLayer({
      workflows: manager.workflows,
      invoke: manager.invoke,
      allowedOrigins,
    }),
    hostRequestPolicy(validated.host, getPort),
  );
  const served = HttpRouter.serve(webApp, {
    disableLogger: true,
    disableListenLog: true,
  });
  const live = Layer.provideMerge(
    served,
    NodeHttpServer.layer(createServer, {
      host: validated.host,
      port: validated.port,
      gracefulShutdownTimeout: "5 seconds",
    }),
  );
  const runtime = ManagedRuntime.make(live);
  const web = HttpRouter.toWebHandler(webApp, { disableLogger: true });
  let disposed = false;
  const toAddress = (hostname: string, port: number) =>
    `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
  let address = toAddress(validated.host, validated.port);
  return {
    host: validated.host,
    get port() {
      return listeningPort;
    },
    get address() {
      return address;
    },
    get ready() {
      return ready && store.healthy;
    },
    async fetch(request) {
      if (disposed) {
        const error = serializeSeqlaneError(
          new Error("Operational host is closed"),
        );
        return new Response(JSON.stringify(error), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
      }
      try {
        request = await boundedFetchRequest(request);
        requestAllowedHeaders(
          {
            host: request.headers.get("host") ?? undefined,
            origin: request.headers.get("origin") ?? undefined,
          },
          new URL(request.url).hostname,
          validated.host,
          listeningPort,
        );
        return await web.handler(request);
      } catch (cause) {
        const error = serializeSeqlaneError(
          cause instanceof Error
            ? cause
            : new Error("Operational request failed", { cause }),
        );
        return new Response(JSON.stringify(error), {
          status: statusForError(cause),
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
      }
    },
    async inspectTrace(traceId) {
      return manager.trace(traceId);
    },
    async listen() {
      if (disposed) throw new Error("Operational host is closed");
      if (ready) return address;
      try {
        const server = await runtime.runPromise(
          Effect.map(HttpServer.HttpServer, (service) => service.address),
        );
        if (server._tag === "UnixPathAddress")
          throw new Error("Operational host requires a TCP listener");
        listeningPort = server.port;
        refreshAllowedOrigins();
        address = toAddress(validated.host, server.port);
        ready = true;
        return address;
      } catch (cause) {
        ready = false;
        throw cause;
      }
    },
    async close() {
      if (disposed) return;
      disposed = true;
      ready = false;
      let failure: { readonly cause: unknown } | undefined;
      try {
        await runtime.dispose();
      } catch (cause) {
        failure = { cause };
      }
      try {
        await manager.shutdown();
      } catch (cause) {
        failure ??= { cause };
      }
      try {
        await web.dispose();
      } catch (cause) {
        failure ??= { cause };
      }
      try {
        await store.close();
      } catch (cause) {
        failure ??= { cause };
      }
      if (failure !== undefined) throw failure.cause;
    },
  };
}
