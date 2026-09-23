import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentAdapterCapabilities,
} from "@seqlane/agent-adapter";
import type { ModelSelection, TaskDefinitionRegistry } from "@seqlane/core";
import type {
  ExecutorModelCapabilities,
  ExecutorRequest,
} from "../../runtime/execution/executor.js";
import { raceWithAbort } from "../../runtime/execution/abortable.js";
import {
  requireStandaloneModelSelection,
  validateStandaloneModelAvailability,
} from "../../runtime/execution/model-preflight.js";
import type { ResolvedExecutorSession } from "../../runtime/session/session-resolution.js";
import { UnsupportedSessionCapabilityError } from "../../runtime/session/session-preflight.js";
import { resolveTaskWorkspaceIdentities } from "../../runtime/workspace/workspace-identity.js";
import { createWorkspaceResources } from "../../runtime/workspace/workspace-resource.js";
import {
  createAgentSession,
  type RuntimeExecution,
  type RuntimeSessionUiNotifier,
} from "./runtime-profile.js";
import {
  createStandaloneAdapterLease,
  type StandaloneAdapterLeaseOptions,
} from "./standalone-adapter.js";
import type { PrivateClassifierConnection } from "../../classifier/types.js";
import { createClassifierTaskRunner } from "../../classifier/system-one-client.js";

/** Supplied by application composition; no concrete adapter configuration. */
export interface StandaloneAdapterBinding {
  readonly capabilities: AgentAdapterCapabilities;
  readonly modelCapabilities?: ExecutorModelCapabilities;
  createAdapter(selection: ModelSelection): AgentAdapter;
}

export interface StandaloneRunOptions {
  readonly workspace: string;
  readonly adapter?: string;
  readonly startAdapter?: StandaloneAdapterLeaseOptions<StandaloneAdapterBinding>["startAdapter"];
  readonly classifierConnection?: PrivateClassifierConnection;
}

export async function createStandaloneExecution(
  options: StandaloneRunOptions,
  taskDefinitions: TaskDefinitionRegistry,
  signal: AbortSignal,
  runId: string,
  onSessionUiAvailable?: RuntimeSessionUiNotifier,
): Promise<RuntimeExecution> {
  const workspaceIdentities = await resolveTaskWorkspaceIdentities(
    taskDefinitions,
    options.workspace,
  );
  const workspaceResources = createWorkspaceResources(workspaceIdentities);
  const lease = createStandaloneAdapterLease({ ...options, signal });
  const adapters = new Set<AgentAdapter>();
  const configurationBinding = randomUUID();
  let closePromise: Promise<void> | undefined;

  function session(
    selection?: ModelSelection,
    resolved?: ResolvedExecutorSession,
  ): ResolvedExecutorSession {
    let actual = resolved;
    let lastInvocation: string | undefined;
    const emptyCheckpoint = Object.freeze({});
    return {
      key: Symbol("standalone-session"),
      ...(selection === undefined ? {} : { effectiveSelection: selection }),
      executor: {
        async execute(request: ExecutorRequest) {
          const selected = requireStandaloneModelSelection({
            nodeId: request.invocationId,
            taskId: request.taskId,
            effectiveSelection: selection ?? request.modelSelection,
          });
          const { binding } = await raceWithAbort(
            lease.acquire(),
            request.signal,
          );
          const capabilities = binding.capabilities;
          const required = ["structuredOutput", "modelSelection"] as const;
          for (const capability of required) {
            if (!capabilities[capability])
              throw new UnsupportedSessionCapabilityError(
                request.invocationId,
                capability,
                capabilities,
              );
          }
          if (
            lastInvocation !== undefined &&
            lastInvocation !== request.invocationId &&
            !capabilities.sessionReuse
          ) {
            throw new UnsupportedSessionCapabilityError(
              request.invocationId,
              "sessionReuse",
              capabilities,
            );
          }
          await raceWithAbort(
            validateStandaloneModelAvailability(
              selected,
              binding.modelCapabilities,
            ),
            request.signal,
          );
          request.signal.throwIfAborted();
          if (actual === undefined) {
            const adapter = binding.createAdapter(selected);
            adapters.add(adapter);
            actual = createAgentSession(
              taskDefinitions,
              adapter,
              onSessionUiAvailable,
              selected,
              {
                adapter: options.adapter ?? "standalone",
                runId,
                configurationBinding,
                capabilities,
              },
              (child) => adapters.add(child),
            );
          }
          lastInvocation = request.invocationId;
          return actual.executor.execute(request);
        },
      },
      async checkpoint() {
        if (actual === undefined) return emptyCheckpoint;
        if (actual.checkpoint === undefined)
          throw new Error("Adapter cannot capture a session checkpoint");
        return actual.checkpoint();
      },
      async fork(request) {
        const branchSelection = request.effectiveSelection ?? selection;
        if (actual === undefined) {
          if (request.checkpoint !== emptyCheckpoint)
            throw new Error("Invalid empty session checkpoint");
          return session(branchSelection);
        }
        if (actual.fork === undefined)
          throw new Error("Adapter cannot fork a session checkpoint");
        return session(branchSelection, await actual.fork(request));
      },
    };
  }

  return {
    taskDefinitions,
    workspaceIdentities,
    workspaceResources,
    classifier: createClassifierTaskRunner(options.classifierConnection),
    executors: { modelPolicy: "authored", agent: () => session().executor },
    sessionResolver: {
      resolve: async ({ effectiveSelection }) => session(effectiveSelection),
    },
    close() {
      return (closePromise ??= (async () => {
        const failures: unknown[] = [];
        const results = await Promise.allSettled(
          [...adapters].map((adapter) => adapter.close?.()),
        );
        for (const result of results)
          if (result.status === "rejected") failures.push(result.reason);
        adapters.clear();
        try {
          await lease.close();
        } catch (cause) {
          failures.push(cause);
        }
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            "Standalone adapter cleanup failed",
          );
      })());
    },
  };
}
