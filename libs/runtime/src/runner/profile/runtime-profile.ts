import type {
  JsonValue,
  ModelSelection,
  RunId,
  TaskDefinitionRegistry,
} from "@seqlane/core";
import type { RuntimeProfileReference } from "@seqlane/protocol";
import { randomUUID } from "node:crypto";
import { InteractionRequiredError, plainRecordSchema } from "@seqlane/core";
import type { AgentAdapter } from "@seqlane/agent-adapter";
import type { RequestContext } from "@mastra/core/request-context";
import type { ExecutorResolvers } from "../../runtime/execution/executor.js";
import type {
  ExecutorRequest,
  SeqlaneExecutor,
} from "../../runtime/execution/executor.js";
import {
  resolveTaskWorkspaceIdentities,
  type WorkspaceIdentityRegistry,
} from "../../runtime/workspace/workspace-identity.js";
import {
  createWorkspaceResources,
  type WorkspaceResourceRegistry,
} from "../../runtime/workspace/workspace-resource.js";
import {
  type ResolvedExecutorSession,
  type SessionResolver,
} from "../../runtime/session/session-resolution.js";
import type { RuntimeSessionUiAvailable } from "../runtime-session-ui.js";
import { z } from "zod";
import {
  configurationWithWorkspace,
  createRuntimeAdapterRegistry,
  loadRuntimeAdapterConfiguration,
  redactRuntimeAdapter,
  assertRuntimeAdapterCapabilities,
  type RuntimeAdapterFactoryContext,
  type RuntimeAdapterFactoryResult,
  type RuntimeAdapterRegistry,
} from "./runtime-adapter.js";

const fixtureInputSchema = plainRecordSchema.pipe(
  z.looseObject({ dependency: z.string().optional() }),
);
export interface RuntimeExecution {
  readonly executors: ExecutorResolvers;
  readonly sessionResolver: SessionResolver;
  readonly taskDefinitions: TaskDefinitionRegistry;
  readonly workspaceIdentities: WorkspaceIdentityRegistry;
  readonly workspaceResources: WorkspaceResourceRegistry;
  readonly close?: () => Promise<void>;
}

export type RuntimeSessionUiNotifier = (
  session: RuntimeSessionUiAvailable,
) => void | Promise<void>;

async function reportSessionUi(
  invocationId: string,
  browserUrl: string | undefined,
  onSessionUiAvailable: RuntimeSessionUiNotifier | undefined,
): Promise<void> {
  if (browserUrl === undefined || onSessionUiAvailable === undefined) return;
  await onSessionUiAvailable({
    type: "runtime.session.ui-available",
    invocationId,
    browserUrl,
  });
}

function createSessionUiExecutor(
  adapter: AgentAdapter,
  taskDefinitions: TaskDefinitionRegistry,
  effectiveSelection: ModelSelection | undefined,
  onSessionUiAvailable: RuntimeSessionUiNotifier | undefined,
): SeqlaneExecutor {
  let reported = false;

  return {
    execute: async (request) => {
      if (!reported) {
        reported = true;
        const browserUrl =
          onSessionUiAvailable === undefined
            ? undefined
            : await adapter.sessionUi?.();
        await reportSessionUi(
          request.invocationId,
          browserUrl,
          onSessionUiAvailable,
        );
      }
      return executeAgentAdapterRequest(
        adapter,
        taskDefinitions,
        effectiveSelection,
        request,
      );
    },
  };
}

const boundCheckpointSchema = z.strictObject({
  version: z.literal(1),
  adapter: z.string().min(1),
  runId: z.string().min(1),
  configurationBinding: z.string().uuid(),
  lineageId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  value: z.unknown(),
});

type BoundCheckpoint = z.output<typeof boundCheckpointSchema>;

export class RuntimeAdapterCheckpointError extends Error {
  constructor(readonly reason: "malformed" | "foreign" | "stale") {
    super(`Runtime adapter checkpoint is ${reason}`);
    this.name = "RuntimeAdapterCheckpointError";
  }
}

interface SessionCheckpointBinding {
  readonly adapter: string;
  readonly runId: RunId;
  readonly configurationBinding: string;
  readonly capabilities: AgentAdapter["capabilities"];
}

interface SessionCheckpointState {
  generation: number;
  latest?: BoundCheckpoint;
}

export function executeAgentAdapterRequest(
  adapter: AgentAdapter,
  taskDefinitions: TaskDefinitionRegistry,
  effectiveSelection: ModelSelection | undefined,
  request: ExecutorRequest,
): Promise<unknown> {
  const task = taskDefinitions.get(request.taskId);
  if (task === undefined) {
    throw new Error(`No task definition found for "${request.taskId}"`);
  }
  return adapter.execute({
    invocationId: request.invocationId,
    observability: request.observability,
    task,
    input: request.input,
    ...(request.agent === undefined ? {} : { agent: request.agent }),
    ...(effectiveSelection === undefined || !adapter.capabilities.modelSelection
      ? {}
      : { modelSelection: effectiveSelection }),
    signal: request.signal,
    onMetrics: request.onMetrics,
    onDiagnostic: (diagnostic) => request.onDiagnostic?.(diagnostic.message),
    onActivity: request.onActivity,
    onUncertainActivity: request.onUncertainActivity,
    onBackgroundProcess: request.onBackgroundProcess,
  });
}

function createAgentSession(
  taskDefinitions: TaskDefinitionRegistry,
  adapter: AgentAdapter,
  onSessionUiAvailable: RuntimeSessionUiNotifier | undefined,
  effectiveSelection: ModelSelection | undefined,
  checkpointBinding: SessionCheckpointBinding,
): ResolvedExecutorSession {
  const checkpointState: SessionCheckpointState = { generation: 0 };
  const capture = adapter.captureCheckpoint;
  const captureCheckpoint =
    capture === undefined
      ? undefined
      : async (): Promise<BoundCheckpoint> => {
          if (checkpointState.generation === 0) {
            throw new RuntimeAdapterCheckpointError("stale");
          }
          const value = await capture();
          const checkpoint = Object.freeze({
            version: 1 as const,
            adapter: checkpointBinding.adapter,
            runId: checkpointBinding.runId,
            configurationBinding: checkpointBinding.configurationBinding,
            lineageId: checkpointBinding.runId + ":" + randomUUID(),
            generation: checkpointState.generation,
            value,
          });
          checkpointState.latest = checkpoint;
          return checkpoint;
        };
  const fork = adapter.fork;
  const sessionAdapter: AgentAdapter = {
    ...adapter,
    execute: async (request) => {
      const result = await adapter.execute(request);
      checkpointState.generation += 1;
      checkpointState.latest = undefined;
      return result;
    },
  };
  return {
    key: Symbol("agent-adapter-session"),
    ...(effectiveSelection === undefined ? {} : { effectiveSelection }),
    executor: createSessionUiExecutor(
      sessionAdapter,
      taskDefinitions,
      effectiveSelection,
      onSessionUiAvailable,
    ),
    ...(captureCheckpoint === undefined
      ? {}
      : { checkpoint: captureCheckpoint }),
    ...(fork === undefined
      ? {}
      : {
          fork: async ({ checkpoint, effectiveSelection: branchSelection }) => {
            const selection = branchSelection ?? effectiveSelection;
            const parsed = boundCheckpointSchema.safeParse(checkpoint);
            if (!parsed.success) {
              throw new RuntimeAdapterCheckpointError("malformed");
            }
            if (
              parsed.data.adapter !== checkpointBinding.adapter ||
              parsed.data.runId !== checkpointBinding.runId ||
              parsed.data.configurationBinding !==
                checkpointBinding.configurationBinding ||
              parsed.data.lineageId !== checkpointState.latest?.lineageId
            ) {
              throw new RuntimeAdapterCheckpointError("foreign");
            }
            if (
              checkpoint !== checkpointState.latest ||
              parsed.data.generation !== checkpointState.generation
            ) {
              throw new RuntimeAdapterCheckpointError("stale");
            }
            const child = await fork({
              checkpoint: parsed.data.value,
              ...(selection === undefined ? {} : { modelSelection: selection }),
            });
            assertRuntimeAdapterCapabilities(
              child,
              checkpointBinding.capabilities,
            );
            return createAgentSession(
              taskDefinitions,
              child,
              onSessionUiAvailable,
              selection,
              checkpointBinding,
            );
          },
        }),
  };
}

function createLazyAgentSession(
  taskDefinitions: TaskDefinitionRegistry,
  createAdapter: (
    context: RuntimeAdapterFactoryContext,
  ) => RuntimeAdapterFactoryResult,
  signal: AbortSignal,
  onSessionUiAvailable: RuntimeSessionUiNotifier | undefined,
  effectiveSelection: ModelSelection | undefined,
  checkpointBinding: SessionCheckpointBinding,
  onAdapterCreated: (adapter: AgentAdapter) => void,
): ResolvedExecutorSession {
  const binding = createAdapter({
    signal,
    ...(effectiveSelection === undefined
      ? {}
      : { modelSelection: effectiveSelection }),
  });
  const adapter = binding.createAdapter();
  onAdapterCreated(adapter);
  assertRuntimeAdapterCapabilities(adapter, checkpointBinding.capabilities);
  return createAgentSession(
    taskDefinitions,
    adapter,
    onSessionUiAvailable,
    effectiveSelection,
    checkpointBinding,
  );
}

export interface RuntimeProfileResolutionOptions {
  /** Private configuration loaded by the caller or runner environment. */
  readonly adapterConfiguration?: unknown;
  /** Test seam and private composition-root override. */
  readonly adapterRegistry?: RuntimeAdapterRegistry;
  readonly runId?: RunId;
  /** Existing Mastra invocation context for operational runs. */
  readonly requestContext?: RequestContext;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Resolves private adapter state after the generic profile crosses IPC. */
export async function resolveRuntimeProfile(
  profile: RuntimeProfileReference,
  taskDefinitions: TaskDefinitionRegistry | undefined,
  signal: AbortSignal,
  input: JsonValue,
  onSessionUiAvailable?: RuntimeSessionUiNotifier,
  options: RuntimeProfileResolutionOptions = {},
): Promise<RuntimeExecution> {
  if (!taskDefinitions) {
    throw new Error("Loaded workflow did not provide task definitions");
  }
  const workspacePath = profile.workspace;

  if (profile.id === "local") {
    const workspaceIdentities = await resolveTaskWorkspaceIdentities(
      taskDefinitions,
      workspacePath,
    );
    const workspaceResources = createWorkspaceResources(workspaceIdentities);
    const localExecutor = (): never => {
      throw new Error('Runtime profile "local" cannot execute agent tasks');
    };
    return {
      executors: { agent: localExecutor },
      sessionResolver: {
        resolve: async () => {
          throw new Error(
            'Runtime profile "local" cannot resolve agent sessions',
          );
        },
      },
      taskDefinitions,
      workspaceIdentities,
      workspaceResources,
      close: async () => undefined,
    };
  }

  if (profile.id === "test-fixture") {
    const workspaceIdentities = await resolveTaskWorkspaceIdentities(
      taskDefinitions,
      workspacePath,
    );
    const workspaceResources = createWorkspaceResources(workspaceIdentities);
    return createTestFixtureExecution(
      taskDefinitions,
      workspaceIdentities,
      workspaceResources,
      signal,
      input,
    );
  }

  const rawConfiguration =
    options.adapterConfiguration === undefined
      ? loadRuntimeAdapterConfiguration(options.environment)
      : options.adapterConfiguration;
  const adapterRegistry =
    options.adapterRegistry ?? createRuntimeAdapterRegistry();
  const selected = adapterRegistry.resolve(
    configurationWithWorkspace(rawConfiguration, workspacePath),
  );
  const preparation = await selected.prepare(signal);
  const capabilities = selected.resolveCapabilities(preparation);
  const binding = selected.create({
    signal,
    ...preparation,
    ...(options.requestContext === undefined
      ? {}
      : { requestContext: options.requestContext }),
  });
  const checkpointBinding: SessionCheckpointBinding = {
    adapter: selected.identity,
    runId: options.runId ?? randomUUID(),
    configurationBinding: selected.configurationBinding,
    capabilities,
  };
  const ownedAdapters = new Set<AgentAdapter>();
  const close = async (): Promise<void> => {
    const adapters = [...ownedAdapters];
    ownedAdapters.clear();
    await Promise.all(
      adapters.map(async (adapter) => {
        await adapter.close?.();
      }),
    );
  };
  const workspaceIdentities = await resolveTaskWorkspaceIdentities(
    taskDefinitions,
    workspacePath,
  );
  const workspaceResources = createWorkspaceResources(workspaceIdentities);
  const sessionResolver: SessionResolver = {
    adapterCapabilities: capabilities,
    modelCapabilities: binding.modelCapabilities,
    resolve: async ({ effectiveSelection }): Promise<ResolvedExecutorSession> =>
      createLazyAgentSession(
        taskDefinitions,
        (context) => {
          const result = selected.create({
            ...context,
            signal,
            ...preparation,
            ...(options.requestContext === undefined
              ? {}
              : { requestContext: options.requestContext }),
          });
          return {
            ...result,
            createAdapter: () =>
              redactRuntimeAdapter(
                result.createAdapter(),
                selected.configuration,
              ),
          };
        },
        signal,
        onSessionUiAvailable,
        effectiveSelection,
        checkpointBinding,
        (adapter) => ownedAdapters.add(adapter),
      ),
  };

  const executors: ExecutorResolvers = {
    agent: () => {
      // A task without a declared session gets a fresh adapter for this
      // one-shot request. It does not create a Seqlane session or checkpoint.
      const oneShotBinding = selected.create({
        signal,
        ...preparation,
        ...(options.requestContext === undefined
          ? {}
          : { requestContext: options.requestContext }),
      });
      const oneShotAdapter = oneShotBinding.createAdapter();
      ownedAdapters.add(oneShotAdapter);
      return {
        execute: (request: ExecutorRequest) =>
          executeAgentAdapterRequest(
            redactRuntimeAdapter(oneShotAdapter, selected.configuration),
            taskDefinitions,
            undefined,
            request,
          ),
      };
    },
  };
  return {
    executors,
    sessionResolver,
    taskDefinitions,
    workspaceIdentities,
    workspaceResources,
    close,
  };
}

async function createTestFixtureExecution(
  taskDefinitions: TaskDefinitionRegistry,
  workspaceIdentities: WorkspaceIdentityRegistry,
  workspaceResources: WorkspaceResourceRegistry,
  signal: AbortSignal,
  input: JsonValue,
): Promise<RuntimeExecution> {
  const fixtureInput = fixtureInputSchema.safeParse(input);
  const inputRecord = fixtureInput.success ? fixtureInput.data : undefined;
  const dependency = inputRecord?.dependency;

  if (dependency === "setup-cancel-case") {
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new Error("fake setup aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  const failOnTaskId =
    dependency === "failure-case" ? "apply-renovate-fix" : undefined;
  const executor: SeqlaneExecutor = {
    execute: async (request: ExecutorRequest) => {
      if (dependency === "cancel-case") {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("fake execution aborted"));
          if (request.signal.aborted) abort();
          else request.signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (request.taskId === failOnTaskId) {
        throw new Error(`fake execution failure in ${request.taskId}`);
      }
      if (
        dependency === "interaction-case" &&
        request.taskId === "apply-renovate-fix"
      ) {
        throw new InteractionRequiredError("user-input");
      }
      switch (request.taskId) {
        case "validation.fixture.produce": {
          const taskInput = request.input as {
            readonly candidate: string;
            readonly shouldPass: boolean;
          };
          return {
            candidate: taskInput.candidate,
            accepted: taskInput.shouldPass,
          };
        }
        case "validation.fixture.dependent": {
          const taskInput = request.input as { readonly candidate: string };
          return { candidate: taskInput.candidate, completed: true };
        }
        case "validation.fixture.repair": {
          const taskInput = request.input as {
            readonly value: string;
            readonly attempt: number;
          };
          return {
            value: taskInput.value,
            attempt: taskInput.attempt + 1,
          };
        }
        case "validation.fixture.evaluator": {
          const taskInput = request.input as { readonly attempt: number };
          return taskInput.attempt >= 2
            ? { success: true, evidence: { attempt: taskInput.attempt } }
            : {
                success: false,
                issues: [
                  {
                    code: "not-ready",
                    message: "The fixture state needs another repair",
                  },
                ],
                evidence: { attempt: taskInput.attempt },
              };
        }
        case "investigate-renovate-failure":
          return {
            files: ["package.json", "pnpm-lock.yaml"],
            rootCause: "Renovate updated a dependency without its peer range",
          };
        case "plan-renovate-fix":
          return {
            steps: ["update peer range", "refresh lockfile"],
            summary: "Apply the dependency and lockfile remediation",
          };
        case "apply-renovate-fix":
          return {
            changedFiles: ["package.json", "pnpm-lock.yaml"],
            summary: "Dependency update and lockfile repaired",
          };
        case "verify-renovate-fix":
          return { passed: true, summary: "Install and targeted tests pass" };
        default:
          throw new Error(`unexpected test task ${request.taskId}`);
      }
    },
  };

  const executors: ExecutorResolvers = {
    agent: () => executor,
  };
  return {
    executors,
    sessionResolver: {
      resolve: async ({ effectiveSelection }) => ({
        key: Symbol("isolated-fixture-session"),
        executor,
        ...(effectiveSelection === undefined ? {} : { effectiveSelection }),
      }),
    },
    taskDefinitions,
    workspaceIdentities,
    workspaceResources,
    close: async () => undefined,
  };
}
