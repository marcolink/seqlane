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
import {
  OPERATIONAL_EVENT_SINK_CONTEXT_KEY,
  OPERATIONAL_REPEAT_BUDGET_CONTEXT_KEY,
  type RepeatExecutionBudget,
} from "../compile/mastra-run-context.js";
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
} from "./mastra-execution.js";
import { instrumentOperationalWorkflow } from "./operational-run-lifecycle.js";
import { workspaceResourcesForExecution } from "./workspace-resources.js";
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
  /** Closes adapter resources for one terminal workflow run. */
  readonly terminate?: (runId: string) => Promise<void>;
  /** Closes adapter resources owned by active runs for this workflow. */
  readonly shutdown?: () => Promise<void>;
  /** Seeds private run-local context before Mastra starts a workflow run. */
  readonly prepareRunContext?: (
    requestContext: RequestContext,
    workId: string,
    runId: string,
  ) => void;
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
  const runStates = new Map<string, OperationalRunState>();
  const events: SeqlaneEventSink = {
    emit: (event) => {
      operationalRunState(
        source,
        runStates,
        event.workId,
        event.runId,
      ).events.emit(event);
    },
  };
  const invocationHandler = createOperationalInvocationHandler(
    source,
    runStates,
  );
  const compiled = compilePlanToMastra(source.plan, {
    workflow: source.workflow,
    workflowDefinitions: source.workflowDefinitions,
    taskDefinitions: source.taskDefinitions,
    validatorDefinitions: source.validatorDefinitions,
    executeInvocation: invocationHandler.invoke,
    executeWorkflowInvocation: invocationHandler.invoke,
    events,
  });
  const prepareRunContext = (
    requestContext: RequestContext,
    workId: string,
    runId: string,
  ): void => {
    setOperationalRunContext(
      requestContext,
      operationalRunState(source, runStates, workId, runId),
    );
  };
  return {
    key: source.key,
    workflow: instrumentOperationalWorkflow(
      compiled.workflow,
      prepareRunContext,
      invocationHandler.terminate,
    ),
    terminate: invocationHandler.terminate,
    shutdown: invocationHandler.shutdown,
    prepareRunContext,
  };
}

interface OperationalRunState {
  readonly workId: string;
  readonly runId: string;
  readonly events: OperationalEventSink;
  readonly repeatBudget: RepeatExecutionBudget;
}

function operationalRunState(
  source: OperationalWorkflowSource,
  states: Map<string, OperationalRunState>,
  workId: string,
  runId: string,
): OperationalRunState {
  const current = states.get(runId);
  if (current !== undefined) {
    if (current.workId !== workId) {
      throw new TypeError(
        `Operational run "${runId}" was already bound to work "${current.workId}"`,
      );
    }
    return current;
  }
  const state: OperationalRunState = {
    workId,
    runId,
    events: source.eventSink?.({ workId, runId }) ?? noExecutionEvents,
    repeatBudget: { executed: 0 },
  };
  states.set(runId, state);
  return state;
}

function setOperationalRunContext(
  requestContext: RequestContext | undefined,
  state: OperationalRunState,
): void {
  requestContext?.setRaw(WORK_ID_CONTEXT_KEY, state.workId);
  requestContext?.setRaw(RUN_ID_CONTEXT_KEY, state.runId);
  requestContext?.setRaw(OPERATIONAL_EVENT_SINK_CONTEXT_KEY, state.events);
  requestContext?.setRaw(
    OPERATIONAL_REPEAT_BUDGET_CONTEXT_KEY,
    state.repeatBudget,
  );
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
  readonly terminate: (runId: string) => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

interface PreparedOperationalInvocation {
  readonly invoke: MastraPlanInvocation;
  readonly close: () => Promise<void>;
}

function createOperationalInvocationHandler(
  source: OperationalWorkflowSource,
  runStates: Map<string, OperationalRunState>,
): OperationalInvocationHandler {
  const preparedByRun = new Map<
    string,
    Promise<PreparedOperationalInvocation>
  >();
  const cleanupByRun = new Map<string, Promise<void>>();
  const activeByRun = new Map<string, Set<Promise<void>>>();

  const closeRun = (
    runId: string,
    pending: Promise<PreparedOperationalInvocation>,
  ): Promise<void> => {
    const cleanup = (async () => {
      await Promise.all(activeByRun.get(runId) ?? []);
      const { close } = await pending;
      await close();
    })().catch(() => undefined);
    cleanupByRun.set(runId, cleanup);
    void cleanup.finally(() => {
      if (cleanupByRun.get(runId) === cleanup) cleanupByRun.delete(runId);
      runStates.delete(runId);
    });
    return cleanup;
  };

  const terminate = (runId: string): Promise<void> => {
    const pending = preparedByRun.get(runId);
    if (pending !== undefined) {
      preparedByRun.delete(runId);
      return closeRun(runId, pending);
    }
    const cleanup = cleanupByRun.get(runId);
    if (cleanup !== undefined) return cleanup;
    runStates.delete(runId);
    return Promise.resolve();
  };

  const invokePrepared: MastraPlanInvocation = async (context) => {
    const pending =
      preparedByRun.get(context.runId) ??
      (async () => {
        if (!isJsonValue(context.workflowInput)) {
          throw new TypeError("Operational workflow input must be JSON");
        }
        const contextWorkId = requestContextValue(
          context.requestContext,
          WORK_ID_CONTEXT_KEY,
        );
        const workId =
          context.resourceId ??
          (typeof contextWorkId === "string" && contextWorkId.length > 0
            ? contextWorkId
            : "unknown-work");
        const state = operationalRunState(
          source,
          runStates,
          workId,
          context.runId,
        );
        setOperationalRunContext(context.requestContext, state);
        const events = state.events;
        const profile = runtimeProfileFromContext(context.requestContext);
        let closeExecution: (() => Promise<void>) | undefined;
        let closeExecutionPromise: Promise<void> | undefined;
        const closeExecutionOnce = (): Promise<void> =>
          (closeExecutionPromise ??= closeExecution?.() ?? Promise.resolve());
        let handedOff = false;
        try {
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
          closeExecution = execution.close;
          const prepared = new PlanCompiler().prepareWorkflow(source.plan, {
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
            const child = source.workflowDefinitions?.get(
              invocation.workflowId,
            );
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
          handedOff = true;
          return {
            invoke,
            close: closeExecutionOnce,
          };
        } finally {
          if (!handedOff) {
            await closeExecutionOnce().catch(() => undefined);
          }
        }
      })();
    preparedByRun.set(context.runId, pending);
    return (await pending).invoke(context);
  };

  const invoke: MastraPlanInvocation = (context) => {
    const active = activeByRun.get(context.runId) ?? new Set<Promise<void>>();
    activeByRun.set(context.runId, active);
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    active.add(settled);
    return invokePrepared(context).finally(() => {
      active.delete(settled);
      if (active.size === 0) activeByRun.delete(context.runId);
      release();
    });
  };

  return {
    invoke,
    terminate,
    shutdown: async () => {
      const pending = [...preparedByRun.entries()];
      preparedByRun.clear();
      await Promise.all([
        ...pending.map(([runId, value]) => closeRun(runId, value)),
        ...cleanupByRun.values(),
      ]);
      runStates.clear();
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
  registrations: ReadonlyMap<
    string,
    Pick<OperationalWorkflowRegistration, "terminate" | "prepareRunContext">
  >,
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
      const registration = registrations.get(workflowKey);
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
      registration?.prepareRunContext?.(runContext, workId, runId);
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
        await registration?.terminate?.(runId);
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
    registerOperationalMastraServer(
      composition,
      new Map(
        options.workflows.map(
          (registration) => [registration.key, registration] as const,
        ),
      ),
    );
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
        await Promise.all(
          options.workflows.map(async ({ shutdown }) => {
            await shutdown?.();
          }),
        );
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
