import type {
  AgentTaskDefinition,
  JsonValue,
  ModelSelection,
  RuntimeProfileReference,
  TaskDefinitionRegistry,
} from "@seqlane/core";
import { InteractionRequiredError, plainRecordSchema } from "@seqlane/core";
import type { AgentAdapter } from "@seqlane/agent-adapter";
import { resolveOpenCodeBrowserUiUrl } from "@seqlane/opencode";
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
  type RuntimeAdapterFactoryContext,
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

export function executeAgentAdapterRequest(
  adapter: AgentAdapter,
  taskDefinitions: TaskDefinitionRegistry,
  effectiveSelection: ModelSelection | undefined,
  request: ExecutorRequest,
): Promise<unknown> {
  const task = taskDefinitions.get(request.taskId);
  if (task === undefined || typeof task.goal !== "function") {
    throw new Error(`No agent task definition found for "${request.taskId}"`);
  }
  const agentTask = task as AgentTaskDefinition;
  return adapter.execute({
    invocationId: request.invocationId,
    task: agentTask,
    input: request.input,
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
): ResolvedExecutorSession {
  const captureCheckpoint = adapter.captureCheckpoint;
  const fork = adapter.fork;
  return {
    key: Symbol("agent-adapter-session"),
    ...(effectiveSelection === undefined ? {} : { effectiveSelection }),
    executor: createSessionUiExecutor(
      adapter,
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
            return createAgentSession(
              taskDefinitions,
              await fork({
                checkpoint,
                ...(selection === undefined
                  ? {}
                  : { modelSelection: selection }),
              }),
              onSessionUiAvailable,
              selection,
            );
          },
        }),
  };
}

function createLazyAgentSession(
  taskDefinitions: TaskDefinitionRegistry,
  createAdapter: (context: RuntimeAdapterFactoryContext) => AgentAdapter,
  signal: AbortSignal,
  onSessionUiAvailable: RuntimeSessionUiNotifier | undefined,
  effectiveSelection: ModelSelection | undefined,
): ResolvedExecutorSession {
  const adapter = createAdapter({
    signal,
    ...(effectiveSelection === undefined
      ? {}
      : { modelSelection: effectiveSelection }),
  });
  return createAgentSession(
    taskDefinitions,
    adapter,
    onSessionUiAvailable,
    effectiveSelection,
  );
}

export interface RuntimeProfileResolutionOptions {
  /** Private configuration loaded by the caller or runner environment. */
  readonly adapterConfiguration?: unknown;
  /** Test seam and private composition-root override. */
  readonly adapterRegistry?: RuntimeAdapterRegistry;
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
    options.adapterConfiguration ??
    loadRuntimeAdapterConfiguration(options.environment);
  const adapterRegistry =
    options.adapterRegistry ?? createRuntimeAdapterRegistry();
  const selected = adapterRegistry.resolve(
    configurationWithWorkspace(rawConfiguration, workspacePath),
  );
  let browserUiUrl: string | undefined;
  if (selected.identity === "opencode") {
    const configuration = selected.configuration;
    if (configuration.adapter !== "opencode") {
      throw new Error("Runtime adapter configuration identity changed");
    }
    browserUiUrl = await resolveOpenCodeBrowserUiUrl(configuration.url, signal);
  }
  const binding = selected.create({ signal, browserUiUrl });
  const workspaceIdentities = await resolveTaskWorkspaceIdentities(
    taskDefinitions,
    workspacePath,
  );
  const workspaceResources = createWorkspaceResources(workspaceIdentities);
  const sessionResolver: SessionResolver = {
    modelCapabilities: binding.modelCapabilities,
    resolve: async ({ effectiveSelection }): Promise<ResolvedExecutorSession> =>
      createLazyAgentSession(
        taskDefinitions,
        (context) =>
          selected
            .create({
              ...context,
              signal,
              browserUiUrl,
            })
            .createAdapter(),
        signal,
        onSessionUiAvailable,
        effectiveSelection,
      ),
  };

  const executors: ExecutorResolvers = {
    agent: () => {
      throw new Error("Task execution requires a resolved executor session");
    },
  };
  return {
    executors,
    sessionResolver,
    taskDefinitions,
    workspaceIdentities,
    workspaceResources,
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
  };
}
