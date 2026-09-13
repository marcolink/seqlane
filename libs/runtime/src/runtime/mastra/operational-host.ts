import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { serve as serveNode, type ServerType } from "@hono/node-server";
import { RequestContext } from "@mastra/core/request-context";
import { MastraServer } from "@mastra/hono";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { isJsonValue } from "@seqlane/core";
import type {
  BuiltWorkflow,
  Plan,
  SeqlaneEventSink,
  TaskDefinitionRegistry,
  ValidatorDefinitionRegistry,
  WorkflowDefinition,
} from "@seqlane/core";
import type {
  RuntimeProfileReference,
  SeqlanePlanSnapshot,
} from "@seqlane/protocol";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  compilePlanToMastra,
  type MastraPlanInvocation,
} from "../compile/mastra-plan-compiler.js";
import { PlanCompiler } from "../compile/compile-plan.js";
import { preflightCompiledWorkflowModels } from "../execution/model-preflight.js";
import { resolveRuntimeProfile } from "../../runner/profile/runtime-profile.js";
import type { RuntimeSessionUiAvailable } from "../../runner/runtime-session-ui.js";
import { createSeqlanePlanSnapshot } from "../../runner/workflow/plan-snapshot.js";
import {
  preflightCompiledWorkflowSessionCapabilities,
  resolveCompiledWorkflowSessions,
} from "../session/session-preflight.js";
import {
  createMastraPlanInvocationHandler,
  executeNestedMastraWorkflow,
  workspaceResourcesForExecution,
} from "./mastra-execution.js";
import {
  createMastraComposition,
  type MastraWorkflowRegistration,
} from "./mastra-composition.js";
import { registerMastraServer } from "./mastra-server.js";
import type { RuntimeAdapterRegistry } from "../../runner/profile/runtime-adapter.js";

export interface OperationalWorkflowRegistration {
  readonly key: string;
  /** Mastra workflow values stay opaque at this boundary. */
  readonly workflow: unknown;
}

export interface OperationalEventSink extends SeqlaneEventSink {
  emitPlan(plan: SeqlanePlanSnapshot, workId: string, runId: string): void;
}

export type OperationalSessionUiNotifier = (
  notification: RuntimeSessionUiAvailable,
) => void | Promise<void>;

export interface OperationalWorkflowSource {
  readonly key: string;
  readonly plan: Plan;
  /** Preserves an authored workflow's input and output validation contract. */
  readonly workflow?: Pick<WorkflowDefinition, "input" | "output">;
  readonly workflowDefinitions?: ReadonlyMap<
    string,
    BuiltWorkflow<unknown, unknown>
  >;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly eventSink?: (context: {
    readonly workId: string;
    readonly runId: string;
  }) => OperationalEventSink;
  readonly onSessionUiAvailable?: OperationalSessionUiNotifier;
  /** Private adapter configuration selected by the composition root. */
  readonly adapterConfiguration?: unknown;
  /** Private adapter registry selected by the composition root or test seam. */
  readonly adapterRegistry?: RuntimeAdapterRegistry;
}

export interface OperationalHostOptions {
  readonly workflows: readonly OperationalWorkflowRegistration[];
  readonly storageUrl?: string;
  readonly host?: string;
  readonly port?: number;
}

export interface OperationalHost {
  readonly host: string;
  readonly port: number;
  readonly address: string;
  readonly ready: boolean;
  fetch(request: Request): Promise<Response>;
  listen(): Promise<string>;
  close(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4111;
const DEFAULT_STORAGE_URL = "file:./.seqlane/mastra.db";
const WORK_ID_CONTEXT_KEY = "seqlane.workId";
const RUN_ID_CONTEXT_KEY = "seqlane.runId";
const LOOPBACK_STUDIO_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function localStudioOrigin(origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  return url.protocol === "http:" && LOOPBACK_STUDIO_HOSTS.has(url.hostname)
    ? origin
    : undefined;
}

interface LoopbackHost {
  readonly bindHost: string;
  readonly addressHost: string;
}

function normalizeLoopbackHost(host: string): LoopbackHost {
  if (host === "localhost" || host === "127.0.0.1") {
    return { bindHost: host, addressHost: host };
  }
  if (host === "::1" || host === "[::1]") {
    return { bindHost: "::1", addressHost: "[::1]" };
  }
  throw new TypeError(
    "Operational host must bind to a loopback address (localhost, 127.0.0.1, or ::1)",
  );
}

function validateOptions(options: OperationalHostOptions): void {
  if (options.workflows.length === 0) {
    throw new TypeError("At least one workflow must be registered");
  }
  if (options.host !== undefined && options.host.length === 0) {
    throw new TypeError("Operational host address must not be empty");
  }
  normalizeLoopbackHost(options.host ?? DEFAULT_HOST);
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535)
  ) {
    throw new TypeError(
      "Operational host port must be an integer from 0 to 65535",
    );
  }
  if (options.storageUrl !== undefined && options.storageUrl.length === 0) {
    throw new TypeError("Operational host storage URL must not be empty");
  }
}

function storageFromUrl(url: string): MastraCompositeStore {
  if (!url.startsWith("file:")) {
    return new LibSQLStore({ id: "seqlane-operational-storage", url });
  }

  const filePath = url.slice("file:".length);
  if (filePath.length === 0) {
    throw new TypeError(
      "Operational host file storage URL must include a path",
    );
  }
  if (filePath === ":memory:" || filePath.startsWith(":memory:?")) {
    return new LibSQLStore({ id: "seqlane-operational-storage", url });
  }

  const resolvedPath = isAbsolute(filePath)
    ? filePath
    : resolve(process.cwd(), filePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  return new LibSQLStore({
    id: "seqlane-operational-storage",
    url: `file:${resolvedPath}`,
  });
}

export function createOperationalWorkflow(
  source: OperationalWorkflowSource,
): OperationalWorkflowRegistration {
  const invocationHandler = createOperationalInvocationHandler(source);
  const compiled = compilePlanToMastra(source.plan, {
    workflow: source.workflow,
    workflowDefinitions: source.workflowDefinitions,
    taskDefinitions: source.taskDefinitions,
    validatorDefinitions: source.validatorDefinitions,
    executeInvocation: invocationHandler.invoke,
    executeWorkflowInvocation: invocationHandler.invoke,
    onWorkflowComplete: ({ runId }) => invocationHandler.complete(runId),
  });
  return { key: source.key, workflow: compiled.workflow };
}

const noExecutionEvents: OperationalEventSink = {
  emit: () => undefined,
  emitPlan: () => undefined,
};

function requestContextValue(
  requestContext: { get(key: string): unknown } | undefined,
  key: string,
): unknown {
  return requestContext?.get(key);
}

function runtimeProfileFromContext(
  requestContext: { get(key: string): unknown } | undefined,
): RuntimeProfileReference {
  const id = requestContextValue(requestContext, "seqlane.runtimeId");
  const workspace = requestContextValue(requestContext, "seqlane.workspace");
  return {
    id: typeof id === "string" && id.length > 0 ? id : "local",
    ...(typeof workspace === "string" && workspace.length > 0
      ? { workspace }
      : {}),
  };
}

interface OperationalInvocationHandler {
  readonly invoke: MastraPlanInvocation;
  readonly complete: (runId: string) => void;
}

interface PreparedOperationalInvocation {
  readonly invoke: MastraPlanInvocation;
}

function createOperationalInvocationHandler(
  source: OperationalWorkflowSource,
): OperationalInvocationHandler {
  const preparedByRun = new Map<
    string,
    Promise<PreparedOperationalInvocation>
  >();

  const invoke: MastraPlanInvocation = async (context) => {
    const pending =
      preparedByRun.get(context.runId) ??
      (async () => {
        if (!isJsonValue(context.workflowInput)) {
          throw new TypeError("Operational workflow input must be JSON");
        }
        const workId = context.resourceId ?? "unknown-work";
        const events: OperationalEventSink =
          source.eventSink?.({ workId, runId: context.runId }) ??
          noExecutionEvents;
        const profile = runtimeProfileFromContext(context.requestContext);
        const execution = await resolveRuntimeProfile(
          profile,
          source.taskDefinitions,
          context.abortSignal,
          context.workflowInput,
          source.onSessionUiAvailable,
          {
            adapterConfiguration: source.adapterConfiguration,
            adapterRegistry: source.adapterRegistry,
            requestContext: context.requestContext,
            runId: context.runId,
          },
        );
        const prepared = new PlanCompiler().compileWorkflow(source.plan, {
          workId,
          runId: context.runId,
          workflowInput: context.workflowInput,
          createInvocationId: (nodeId) =>
            `${source.plan.workflow.id}:${nodeId}`,
          executors: execution.executors,
          sessionResolver: execution.sessionResolver,
          workspaceResources: workspaceResourcesForExecution(
            execution.workspaceResources,
            source.workflowDefinitions,
          ),
          taskDefinitions: execution.taskDefinitions,
          validatorDefinitions: source.validatorDefinitions,
          workflowDefinitions: source.workflowDefinitions,
          events,
        });
        preflightCompiledWorkflowSessionCapabilities(prepared);
        await preflightCompiledWorkflowModels(prepared);
        await resolveCompiledWorkflowSessions(prepared);
        if (source.eventSink !== undefined) {
          events.emitPlan(
            createSeqlanePlanSnapshot(prepared.plan),
            workId,
            context.runId,
          );
        }
        const invokeWorkflow: MastraPlanInvocation = async (invocation) => {
          const child = source.workflowDefinitions?.get(invocation.workflowId);
          if (child === undefined) {
            throw new Error(
              `No nested workflow definition registered for "${invocation.workflowId}"`,
            );
          }
          return executeNestedMastraWorkflow({
            parent: prepared,
            invocation,
            child,
            executors: execution.executors,
            sessionResolver: execution.sessionResolver,
            workspaceResources: prepared.context.workspaceResources,
            events,
          });
        };
        const invoke = createMastraPlanInvocationHandler(
          prepared,
          source.plan,
          invokeWorkflow,
        );
        return { invoke };
      })();
    preparedByRun.set(context.runId, pending);
    try {
      return await (await pending).invoke(context);
    } catch (error) {
      if (preparedByRun.get(context.runId) === pending) {
        preparedByRun.delete(context.runId);
      }
      throw error;
    }
  };

  return {
    invoke,
    complete: (runId) => {
      preparedByRun.delete(runId);
    },
  };
}

function asMastraRegistrations(
  registrations: readonly OperationalWorkflowRegistration[],
): readonly MastraWorkflowRegistration[] {
  return registrations.map((registration) => ({
    key: registration.key,
    // Mastra types are intentionally confined to this runtime integration edge.
    workflow: registration.workflow as never,
  }));
}

function registerOperationalMastraServer(
  composition: ReturnType<typeof createMastraComposition>,
): void {
  registerMastraServer(
    composition.mastra,
    composition.workflows,
    async ({ workflowKey, input, runtime, requestContext, abortSignal }) => {
      const workflow = composition.workflows[workflowKey];
      if (workflow === undefined) {
        throw new TypeError(`Unknown Mastra workflow: "${workflowKey}"`);
      }

      const workId = `mcp-work-${randomUUID()}`;
      const runId = `mcp-run-${randomUUID()}`;
      const run = await workflow.createRun({
        runId,
        resourceId: workId,
        shouldPersistSnapshot: () => true,
      });
      let cancelled = false;
      const cancel = (): void => {
        cancelled = true;
        void run.cancel().catch(() => undefined);
      };
      if (abortSignal.aborted) {
        cancel();
      } else {
        abortSignal.addEventListener("abort", cancel, { once: true });
      }

      const runContext = new RequestContext(requestContext.entries());
      runContext.setRaw(WORK_ID_CONTEXT_KEY, workId);
      runContext.setRaw(RUN_ID_CONTEXT_KEY, runId);
      runContext.setRaw("seqlane.runtimeId", runtime?.id ?? "opencode");
      if (runtime?.workspace !== undefined) {
        runContext.setRaw("seqlane.workspace", runtime.workspace);
      }
      try {
        if (cancelled) return { status: "cancelled" };
        const result = await run.start({
          inputData: input,
          requestContext: runContext,
          tracingOptions: {
            metadata: {
              [WORK_ID_CONTEXT_KEY]: workId,
              [RUN_ID_CONTEXT_KEY]: runId,
            },
          },
        });
        return cancelled ? { status: "cancelled" } : result;
      } finally {
        abortSignal.removeEventListener("abort", cancel);
      }
    },
    undefined,
    { runtimeProfileInput: true },
  );
}

export async function createOperationalHost(
  options: OperationalHostOptions,
): Promise<OperationalHost> {
  validateOptions(options);
  const { bindHost, addressHost } = normalizeLoopbackHost(
    options.host ?? DEFAULT_HOST,
  );
  const port = options.port ?? DEFAULT_PORT;
  let composition: ReturnType<typeof createMastraComposition> | undefined;

  try {
    const storage = storageFromUrl(options.storageUrl ?? DEFAULT_STORAGE_URL);
    composition = createMastraComposition(
      asMastraRegistrations(options.workflows),
      storage,
    );
    registerOperationalMastraServer(composition);
    const app = new Hono();
    app.use(cors({ origin: localStudioOrigin, credentials: true }));
    const adapter = new MastraServer({ app, mastra: composition.mastra });

    await storage.init();
    await adapter.init();
    let nodeServer: ServerType | undefined;
    let closed = false;
    let listeningPort = port;
    let ready = false;

    app.get("/", (context) =>
      context.json({ status: "ok", service: "seqlane" }),
    );
    app.get("/healthz", (context) =>
      context.json({ status: "ok", service: "seqlane" }),
    );
    app.get("/readyz", (context) =>
      context.json(
        { status: ready ? "ready" : "starting", service: "seqlane" },
        ready ? 200 : 503,
      ),
    );

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      ready = false;
      try {
        await new Promise<void>((resolveClose, rejectClose) => {
          if (nodeServer === undefined) {
            resolveClose();
            return;
          }
          nodeServer.close((error) => {
            const closeError = error as (Error & { code?: string }) | undefined;
            if (
              closeError === undefined ||
              closeError.code === "ERR_SERVER_NOT_RUNNING"
            ) {
              resolveClose();
            } else rejectClose(closeError);
          });
        });
      } finally {
        await composition?.shutdown();
      }
    };

    const operationalHost: OperationalHost = {
      host: bindHost,
      get port() {
        return listeningPort;
      },
      get address() {
        return `http://${addressHost}:${listeningPort}`;
      },
      get ready() {
        return ready;
      },
      fetch: async (request) => app.fetch(request),
      listen: () => {
        if (closed) {
          return Promise.reject(new Error("Operational host is closed"));
        }
        if (ready) return Promise.resolve(operationalHost.address);

        return new Promise<string>((resolveListen, rejectListen) => {
          const onError = (error: Error & { code?: string }) => {
            nodeServer?.removeListener("error", onError);
            nodeServer = undefined;
            ready = false;
            rejectListen(error);
            void composition?.shutdown();
          };
          const onListening = () => {
            nodeServer?.removeListener("error", onError);
            const address = nodeServer?.address();
            if (address !== null && typeof address === "object") {
              listeningPort = address.port;
            }
            ready = true;
            resolveListen(operationalHost.address);
          };

          try {
            nodeServer = serveNode(
              {
                fetch: app.fetch,
                hostname: bindHost,
                port,
              },
              onListening,
            );
            nodeServer.once("error", onError);
          } catch (cause) {
            rejectListen(cause);
          }
        });
      },
      close,
    };
    return operationalHost;
  } catch (cause) {
    await composition?.shutdown();
    throw new Error("Could not initialize Seqlane operational host", {
      cause,
    });
  }
}
