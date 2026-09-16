import type {
  ModelRef,
  ModelSelection,
  PlanNode,
  TaskNode,
} from "@seqlane/core";
import type { PreparedPlanExecution } from "../compile/compile-plan.js";
import {
  describeModelSelection,
  getExecutorModelCapabilities,
  type ExecutorModelCapabilities,
  type ResolvedExecutorModelCapabilities,
} from "./executor.js";

export class UnavailableExecutorModelError extends Error {
  readonly executor: string;
  readonly requested: ModelSelection;
  readonly available: readonly ModelRef[];

  constructor(options: {
    readonly executor: string;
    readonly requested: ModelSelection;
    readonly available: readonly ModelRef[];
  }) {
    const alternatives =
      options.available.length === 0
        ? "none"
        : options.available
            .map(({ provider, model }) => `${provider}/${model}`)
            .join(", ");
    super(
      `Executor "${options.executor}" does not provide requested model ` +
        `"${describeModelSelection(options.requested)}"; available alternatives: ${alternatives}`,
    );
    this.name = "UnavailableExecutorModelError";
    this.executor = options.executor;
    this.requested = options.requested;
    this.available = options.available;
  }
}

export class MissingExecutorModelCapabilitiesError extends Error {
  constructor(
    readonly executor: string,
    readonly requested: ModelSelection,
  ) {
    super(
      `Executor "${executor}" cannot validate requested model "${describeModelSelection(requested)}" because model capabilities are unavailable`,
    );
    this.name = "MissingExecutorModelCapabilitiesError";
  }
}

/** A standalone run cannot rely on an adapter-selected model. */
export class MissingWorkflowModelSelectionError extends Error {
  constructor(
    readonly nodeId: string,
    readonly taskId: string,
  ) {
    super(
      `Agent task "${taskId}" at "${nodeId}" has no model selection; declare a session model or workflow model`,
    );
    this.name = "MissingWorkflowModelSelectionError";
  }
}

/** Requires the authored selection used for one standalone agent invocation. */
export function requireStandaloneModelSelection(options: {
  readonly nodeId: string;
  readonly taskId: string;
  readonly effectiveSelection?: ModelSelection;
  readonly workflowModel?: ModelSelection;
}): ModelSelection {
  const selection = options.effectiveSelection ?? options.workflowModel;
  if (selection === undefined) {
    throw new MissingWorkflowModelSelectionError(
      options.nodeId,
      options.taskId,
    );
  }
  return selection;
}

/** Checks one selected standalone model when its adapter exposes a catalog. */
export async function validateStandaloneModelAvailability(
  selection: ModelSelection,
  capabilities: ExecutorModelCapabilities | undefined,
): Promise<void> {
  if (capabilities === undefined) return;
  const available = await capabilities.listModels();
  if (!available.some((model) => sameModel(model, selection.model))) {
    throw new UnavailableExecutorModelError({
      executor: capabilities.executor,
      requested: selection,
      available,
    });
  }
  await capabilities.validateModelSelection?.(selection);
}

interface ModelRequirement {
  readonly invocationId: string;
  readonly nodeId: string;
  readonly selection: ModelSelection;
  readonly capabilities: ResolvedExecutorModelCapabilities;
}

interface ModelPreflightNode {
  readonly node: TaskNode;
  readonly nodeId: string;
  readonly taskId: string;
  readonly dynamic: boolean;
}

function modelPreflightNodes(
  compiled: PreparedPlanExecution,
): readonly ModelPreflightNode[] {
  const nodeForPlanNode = (
    node: PlanNode,
    dynamic: boolean,
  ): ModelPreflightNode | undefined => {
    if (node.type === "task") {
      if (node.session === undefined) return undefined;
      return {
        node,
        nodeId: node.nodeId,
        taskId: node.taskId,
        dynamic,
      };
    }
    return undefined;
  };

  return compiled.plan.nodes.flatMap((node) => {
    if (node.type === "repeat") {
      const preflightNode = nodeForPlanNode(node.attempt, true);
      return preflightNode === undefined ? [] : [preflightNode];
    }
    const preflightNode = nodeForPlanNode(node, false);
    return preflightNode === undefined ? [] : [preflightNode];
  });
}

async function modelSelectionForTaskNode(
  node: TaskNode,
  nodesById: ReadonlyMap<string, TaskNode>,
  selections: Map<string, ModelSelection | undefined>,
  capabilitiesForTask: (
    node: TaskNode,
  ) => ResolvedExecutorModelCapabilities | undefined,
  defaults: Map<string, ModelSelection>,
  workflowModel: ModelSelection | undefined,
  resolving = new Set<string>(),
): Promise<ModelSelection | undefined> {
  if (selections.has(node.nodeId)) return selections.get(node.nodeId);
  if (resolving.has(node.nodeId)) return undefined;
  resolving.add(node.nodeId);

  const policy = node.session;
  let selection: ModelSelection | undefined;
  if (policy?.type === "isolated" || policy?.type === "branch") {
    selection =
      policy.model ??
      (policy.type === "branch"
        ? await modelSelectionForSource(policy.from)
        : undefined);
  } else if (policy?.type === "reuse") {
    selection = await modelSelectionForSource(policy.from);
  }

  if (
    selection === undefined &&
    (policy === undefined || policy.type === "isolated")
  ) {
    selection = workflowModel;
  }

  if (selection === undefined && policy?.type !== "reuse") {
    selection = await resolveDefaultSelection(
      capabilitiesForTask(node),
      defaults,
    );
  }

  selections.set(node.nodeId, selection);
  resolving.delete(node.nodeId);
  return selection;

  async function modelSelectionForSource(
    sourceNodeId: string,
  ): Promise<ModelSelection | undefined> {
    const source = nodesById.get(sourceNodeId);
    return source === undefined
      ? undefined
      : modelSelectionForTaskNode(
          source,
          nodesById,
          selections,
          capabilitiesForTask,
          defaults,
          workflowModel,
          resolving,
        );
  }
}

function capabilityForNode(
  compiled: PreparedPlanExecution,
  node: TaskNode,
): ResolvedExecutorModelCapabilities | undefined {
  const executorCapabilities = getExecutorModelCapabilities(
    compiled.context.executors,
    node,
  );
  if (executorCapabilities !== undefined) return executorCapabilities;

  const resolverCapabilities =
    compiled.context.sessionResolver?.modelCapabilities;
  if (resolverCapabilities !== undefined) {
    return {
      executor: resolverCapabilities.executor,
      capabilities: resolverCapabilities,
    };
  }
  return undefined;
}

async function resolveDefaultSelection(
  capabilities: ResolvedExecutorModelCapabilities | undefined,
  defaults: Map<string, ModelSelection>,
): Promise<ModelSelection | undefined> {
  if (capabilities === undefined) return undefined;
  const key = capabilities.executor;
  const cached = defaults.get(key);
  if (cached !== undefined) return cached;
  const selection = await capabilities.capabilities.resolveDefaultModel();
  defaults.set(key, selection);
  return selection;
}

async function availableModels(
  capabilities: ExecutorModelCapabilities,
): Promise<readonly ModelRef[]> {
  return capabilities.listModels();
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function requirementKey(requirement: ModelRequirement): string {
  return `${requirement.capabilities.executor}\0${requirement.selection.model.provider}\0${requirement.selection.model.model}\0${requirement.selection.reasoning ?? ""}`;
}

/** Resolves defaults and validates every model needed by a compiled workflow. */
export async function preflightCompiledWorkflowModels(
  compiled: PreparedPlanExecution,
): Promise<void> {
  const nodes = modelPreflightNodes(compiled);
  const taskNodes = nodes.map(({ node }) => node);
  const nodesById = new Map(taskNodes.map((node) => [node.nodeId, node]));
  const selections = new Map<string, ModelSelection | undefined>();
  const requirements = new Map<string, ModelRequirement>();
  const defaults = new Map<string, ModelSelection>();
  const effectiveSelections = new Map<string, ModelSelection>();
  const effectiveSelectionsByNode = new Map<string, ModelSelection>();

  for (const preflightNode of nodes) {
    const capabilities = capabilityForNode(compiled, preflightNode.node);
    const effectiveSelection = await modelSelectionForTaskNode(
      preflightNode.node,
      nodesById,
      selections,
      (taskNode) => capabilityForNode(compiled, taskNode),
      defaults,
      compiled.context.workflowModel,
    );

    if (effectiveSelection !== undefined) {
      const invocationId =
        compiled.context.invocationIds.get(preflightNode.nodeId) ??
        preflightNode.nodeId;
      if (capabilities === undefined) {
        throw new MissingExecutorModelCapabilitiesError(
          "unknown executor",
          effectiveSelection,
        );
      } else {
        requirements.set(
          requirementKey({
            invocationId,
            nodeId: preflightNode.nodeId,
            selection: effectiveSelection,
            capabilities,
          }),
          {
            invocationId,
            nodeId: preflightNode.nodeId,
            selection: effectiveSelection,
            capabilities,
          },
        );
      }
      if (!preflightNode.dynamic) {
        effectiveSelections.set(invocationId, effectiveSelection);
      } else {
        effectiveSelectionsByNode.set(preflightNode.nodeId, effectiveSelection);
      }
    }
  }

  const modelsByExecutor = new Map<string, readonly ModelRef[]>();
  for (const requirement of requirements.values()) {
    const executor = requirement.capabilities.executor;
    let available = modelsByExecutor.get(executor);
    if (available === undefined) {
      available = await availableModels(requirement.capabilities.capabilities);
      modelsByExecutor.set(executor, available);
    }
    if (
      !available.some((model) => sameModel(model, requirement.selection.model))
    ) {
      throw new UnavailableExecutorModelError({
        executor,
        requested: requirement.selection,
        available,
      });
    }
    await requirement.capabilities.capabilities.validateModelSelection?.(
      requirement.selection,
    );
  }

  for (const [invocationId, selection] of effectiveSelections) {
    compiled.context.effectiveModelSelections.set(invocationId, selection);
  }
  for (const [nodeId, selection] of effectiveSelectionsByNode) {
    compiled.context.effectiveModelSelectionsByNode.set(nodeId, selection);
  }
}
