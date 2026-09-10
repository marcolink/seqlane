import type {
  Plan,
  PlanNode,
  RepeatNode,
  TaskDefinitionRegistry,
  TaskNode,
  ValidationNode,
  ValueBinding,
} from "@seqlane/core";
import {
  modelSelectionSchema,
  planSchema,
  planSessionPolicySchema,
  valueRefSchema,
  validationSourceSchema,
  taskDefinitionSchema,
  workspacePolicySchema,
  MAX_REPEAT_BODY_EXECUTIONS,
  type ModelSelection,
} from "@seqlane/core";
import { z } from "zod";
import { WORKFLOW_INPUT_NODE_ID } from "../plan/binding-resolution.js";

const valueRefNodeIdSchema = z.string();
const valueRefPathSchema = z.array(z.string());

// This projection preserves targeted semantic diagnostics for malformed
// in-memory fixtures after the canonical session schema rejects them.
const sessionPolicyDiagnosticSchema = z.union([
  z.looseObject({
    type: z.literal("isolated"),
    model: z.unknown().optional(),
  }),
  z.looseObject({ type: z.literal("reuse"), from: z.string().min(1) }),
  z.looseObject({
    type: z.literal("branch"),
    from: z.string().min(1),
    model: z.unknown().optional(),
  }),
]);

export type PlanValidationIssueCode =
  | "invalid-plan-schema"
  | "empty-node-id"
  | "duplicate-node-id"
  | "unknown-dependency"
  | "self-dependency"
  | "duplicate-dependency"
  | "dependency-cycle"
  | "unknown-value-ref-target"
  | "missing-value-ref-dependency"
  | "invalid-value-ref-path"
  | "invalid-repeat-limit"
  | "empty-repeat-body"
  | "invalid-repeat-condition"
  | "invalid-repeat-body-reference"
  | "repeat-body-cycle"
  | "invalid-validation-source"
  | "invalid-validation-policy"
  | "unknown-validation-check"
  | "validation-check-not-dependency"
  | "repeat-postcondition-outside-body"
  | "repeat-postcondition-not-final"
  | "repeat-postcondition-check-out-of-scope"
  | "invalid-repeat-postcondition"
  | "invalid-workspace-policy"
  | "invalid-session-policy"
  | "invalid-session-model"
  | "session-model-conflict"
  | "invalid-session-source"
  | "missing-session-dependency"
  | "forbidden-permission-configuration"
  | "missing-task-definition"
  | "invalid-task-definition";

export interface PlanValidationIssue {
  readonly code: PlanValidationIssueCode;
  readonly message: string;
  readonly nodeId?: string;
}

export class PlanValidationError extends Error {
  readonly issues: readonly PlanValidationIssue[];

  constructor(issues: readonly PlanValidationIssue[]) {
    super(issues.map(({ message }) => message).join("; "));
    this.name = "PlanValidationError";
    this.issues = issues;
  }
}

function addIssue(
  issues: PlanValidationIssue[],
  code: PlanValidationIssueCode,
  message: string,
  nodeId?: string,
): void {
  issues.push({ code, message, nodeId });
}

function validateTaskWorkspace(
  node: TaskNode,
  issues: PlanValidationIssue[],
): void {
  if (!workspacePolicySchema.safeParse(node.workspace).success) {
    addIssue(
      issues,
      "invalid-workspace-policy",
      `Task "${node.nodeId}" must declare a valid workspace policy`,
      node.nodeId,
    );
  }

  if (
    ["permission", "permissions", "capabilities"].some((field) =>
      Object.hasOwn(node, field),
    )
  ) {
    addIssue(
      issues,
      "forbidden-permission-configuration",
      `Task "${node.nodeId}" must not declare Seqlane permission configuration`,
      node.nodeId,
    );
  }
}

function validateTaskDefinition(
  node: TaskNode,
  taskDefinitions: TaskDefinitionRegistry | undefined,
  issues: PlanValidationIssue[],
  validateDefinitions: boolean,
): void {
  if (!validateDefinitions) return;

  const definition = taskDefinitions?.get(node.taskId);
  if (definition === undefined) {
    addIssue(
      issues,
      "missing-task-definition",
      `Task "${node.nodeId}" has no registered definition for "${node.taskId}"`,
      node.nodeId,
    );
    return;
  }

  if (!taskDefinitionSchema.safeParse(definition).success) {
    addIssue(
      issues,
      "invalid-task-definition",
      `Task definition "${node.taskId}" is malformed`,
      node.nodeId,
    );
  }
}

type ParsedSessionPolicy = z.output<typeof sessionPolicyDiagnosticSchema>;

function describeModelSelection(selection: ModelSelection | undefined): string {
  if (selection === undefined) return "an unspecified executor default";
  const reasoning = selection.reasoning
    ? ` (reasoning: ${selection.reasoning})`
    : "";
  return `${selection.model.provider}/${selection.model.model}${reasoning}`;
}

function parseSessionModel(
  node: TaskNode,
  policy: ParsedSessionPolicy,
  issues: PlanValidationIssue[],
): ModelSelection | undefined {
  if (!Object.hasOwn(node.session ?? {}, "model")) return undefined;

  const result = modelSelectionSchema.safeParse(
    "model" in policy ? policy.model : undefined,
  );
  if (!result.success) {
    addIssue(
      issues,
      "invalid-session-model",
      `Task "${node.nodeId}" must declare a valid model selection under its session`,
      node.nodeId,
    );
    return undefined;
  }
  return result.data;
}

function resolveSessionSelections(
  nodes: readonly PlanNode[],
  nodesById: ReadonlyMap<string, PlanNode>,
  issues: PlanValidationIssue[],
): ReadonlyMap<string, ModelSelection | undefined> {
  const selections = new Map<string, ModelSelection | undefined>();
  const resolving = new Set<string>();

  const resolve = (nodeId: string): ModelSelection | undefined => {
    if (selections.has(nodeId)) return selections.get(nodeId);
    if (resolving.has(nodeId)) return undefined;

    const node = nodesById.get(nodeId);
    if (node?.type !== "task") return undefined;
    resolving.add(nodeId);

    if (node.session === undefined) {
      selections.set(nodeId, undefined);
      resolving.delete(nodeId);
      return undefined;
    }

    const canonicalPolicy = planSessionPolicySchema.safeParse(node.session);
    const policy = canonicalPolicy.success
      ? canonicalPolicy
      : sessionPolicyDiagnosticSchema.safeParse(node.session);
    if (!policy.success) {
      addIssue(
        issues,
        "invalid-session-policy",
        `Task "${node.nodeId}" must declare a valid session policy`,
        node.nodeId,
      );
      selections.set(nodeId, undefined);
      resolving.delete(nodeId);
      return undefined;
    }

    const declaredSelection = parseSessionModel(node, policy.data, issues);
    if (policy.data.type === "isolated") {
      selections.set(nodeId, declaredSelection);
      resolving.delete(nodeId);
      return declaredSelection;
    }

    const source = nodesById.get(policy.data.from);
    if (source?.type !== "task") {
      addIssue(
        issues,
        "invalid-session-source",
        `Task "${node.nodeId}" ${policy.data.type}s session source "${policy.data.from}" must be an agent task`,
        node.nodeId,
      );
    }
    if (!node.dependsOn.includes(policy.data.from)) {
      addIssue(
        issues,
        "missing-session-dependency",
        `Task "${node.nodeId}" must list its ${policy.data.type} session source "${policy.data.from}" as a dependency`,
        node.nodeId,
      );
    }

    const inheritedSelection =
      source?.type === "task" ? resolve(source.nodeId) : undefined;
    if (policy.data.type === "reuse" && Object.hasOwn(node.session, "model")) {
      addIssue(
        issues,
        "session-model-conflict",
        `Task "${node.nodeId}" cannot declare ${describeModelSelection(declaredSelection)} on a reuse session; it inherits ${describeModelSelection(inheritedSelection)}. Use a branch or isolated session to select a different provider/model or reasoning effort`,
        node.nodeId,
      );
    }

    const effectiveSelection =
      policy.data.type === "branch"
        ? (declaredSelection ?? inheritedSelection)
        : inheritedSelection;
    selections.set(nodeId, effectiveSelection);
    resolving.delete(nodeId);
    return effectiveSelection;
  };

  for (const node of nodes) {
    if (node.type === "task") resolve(node.nodeId);
  }
  return selections;
}

function validateReferences(
  binding: ValueBinding,
  owner: PlanNode | undefined,
  nodesById: ReadonlyMap<string, PlanNode>,
  issues: PlanValidationIssue[],
  allowedNodeIds: ReadonlySet<string> = new Set(),
  allowWorkflowInput = true,
  unknownReferenceCode: PlanValidationIssueCode = "unknown-value-ref-target",
): void {
  const valueRefResult = valueRefSchema.safeParse(binding);
  if (valueRefResult.success) {
    const nodeIdResult = valueRefNodeIdSchema.safeParse(
      valueRefResult.data.nodeId,
    );
    const pathResult = valueRefPathSchema.safeParse(valueRefResult.data.path);

    if (nodeIdResult.success) {
      const nodeId = nodeIdResult.data;

      if (nodeId === WORKFLOW_INPUT_NODE_ID) {
        if (!allowWorkflowInput) {
          addIssue(
            issues,
            "invalid-repeat-body-reference",
            `Repeat body references workflow input instead of its state input`,
            owner?.nodeId,
          );
        }
      } else if (allowedNodeIds.has(nodeId)) {
        if (owner && !owner.dependsOn.includes(nodeId)) {
          addIssue(
            issues,
            "missing-value-ref-dependency",
            `ValueRef target "${nodeId}" in "${owner.nodeId}" must be listed as a dependency`,
            owner.nodeId,
          );
        }
      } else if (!nodesById.has(nodeId)) {
        addIssue(
          issues,
          unknownReferenceCode,
          unknownReferenceCode === "invalid-repeat-body-reference"
            ? `Repeat body references out-of-scope node "${nodeId}"`
            : `Unknown ValueRef target "${nodeId}"${owner ? ` in "${owner.nodeId}"` : ""}`,
          owner?.nodeId,
        );
      } else if (owner && !owner.dependsOn.includes(nodeId)) {
        addIssue(
          issues,
          "missing-value-ref-dependency",
          `ValueRef target "${nodeId}" in "${owner.nodeId}" must be listed as a dependency`,
          owner.nodeId,
        );
      }
    }

    if (!pathResult.success) {
      addIssue(
        issues,
        "invalid-value-ref-path",
        `ValueRef in${owner ? ` "${owner.nodeId}"` : " the Plan output"} must have a string path`,
        owner?.nodeId,
      );
    }
    return;
  }

  // Keep the canonical schema as the syntax authority, but retain the
  // targeted semantic diagnostic for malformed in-memory ValueRef fixtures.
  // The loader rejects these values before execution; this branch only makes
  // direct runtime validation report the established issue code.
  const taggedValueRef = z
    .looseObject({ type: z.literal("ref") })
    .safeParse(binding);
  if (taggedValueRef.success) {
    addIssue(
      issues,
      "invalid-value-ref-path",
      `ValueRef in${owner ? ` "${owner.nodeId}"` : " the Plan output"} must have a string path`,
      owner?.nodeId,
    );
    return;
  }

  if (Array.isArray(binding)) {
    for (const item of binding) {
      validateReferences(
        item,
        owner,
        nodesById,
        issues,
        allowedNodeIds,
        allowWorkflowInput,
        unknownReferenceCode,
      );
    }
    return;
  }

  if (typeof binding === "object" && binding !== null) {
    for (const value of Object.values(binding)) {
      validateReferences(
        value,
        owner,
        nodesById,
        issues,
        allowedNodeIds,
        allowWorkflowInput,
        unknownReferenceCode,
      );
    }
  }
}

function validateValidationNode(
  node: ValidationNode,
  nodesById: ReadonlyMap<string, PlanNode>,
  issues: PlanValidationIssue[],
  inRepeatBody: boolean,
  bodyNodeIds?: ReadonlySet<string>,
  taskDefinitions?: TaskDefinitionRegistry,
  validateDefinitions = true,
): void {
  if (node.type === "validation.check") {
    if (!validationSourceSchema.safeParse(node.source).success) {
      addIssue(
        issues,
        "invalid-validation-source",
        `Validation check "${node.nodeId}" must have a mechanical validatorId or task taskId`,
        node.nodeId,
      );
    }
    if (
      validateDefinitions &&
      node.source.type === "task" &&
      taskDefinitions !== undefined
    ) {
      const definition = taskDefinitions.get(node.source.taskId);
      if (
        definition !== undefined &&
        !taskDefinitionSchema.safeParse(definition).success
      ) {
        addIssue(
          issues,
          "invalid-task-definition",
          `Validation check "${node.nodeId}" has a malformed task definition for "${node.source.taskId}"`,
          node.nodeId,
        );
      }
    }
  } else {
    if (node.policy !== "fail" && node.policy !== "repeat-postcondition") {
      addIssue(
        issues,
        "invalid-validation-policy",
        `Validation gate "${node.nodeId}" has an invalid policy`,
        node.nodeId,
      );
    }
    if (node.policy === "repeat-postcondition" && !inRepeatBody) {
      addIssue(
        issues,
        "repeat-postcondition-outside-body",
        `Repeat-postcondition gate "${node.nodeId}" must be inside a repeat body`,
        node.nodeId,
      );
    }

    const check =
      typeof node.checkNodeId === "string"
        ? nodesById.get(node.checkNodeId)
        : undefined;
    if (check === undefined || check.type !== "validation.check") {
      addIssue(
        issues,
        "unknown-validation-check",
        `Validation gate "${node.nodeId}" must reference a validation check node`,
        node.nodeId,
      );
    } else if (!node.dependsOn.includes(node.checkNodeId)) {
      addIssue(
        issues,
        "validation-check-not-dependency",
        `Validation gate "${node.nodeId}" must list its check node "${node.checkNodeId}" as a dependency`,
        node.nodeId,
      );
    }

    if (
      inRepeatBody &&
      bodyNodeIds &&
      typeof node.checkNodeId === "string" &&
      !bodyNodeIds.has(node.checkNodeId)
    ) {
      addIssue(
        issues,
        "repeat-postcondition-check-out-of-scope",
        `Repeat-body validation gate "${node.nodeId}" must reference a body-local check node`,
        node.nodeId,
      );
    }
  }
}

function dependencyCycle(
  nodes: readonly PlanNode[],
  nodesById: ReadonlyMap<string, PlanNode>,
): readonly string[] | undefined {
  const state = new Map<string, "visiting" | "visited">();
  const path: string[] = [];

  const visit = (nodeId: string): readonly string[] | undefined => {
    const currentState = state.get(nodeId);
    if (currentState === "visiting") {
      const start = path.indexOf(nodeId);
      return [...path.slice(start), nodeId];
    }
    if (currentState === "visited") return undefined;

    state.set(nodeId, "visiting");
    path.push(nodeId);
    const node = nodesById.get(nodeId);
    if (node) {
      for (const dependency of node.dependsOn) {
        if (!nodesById.has(dependency)) continue;
        const cycle = visit(dependency);
        if (cycle !== undefined) return cycle;
      }
    }
    path.pop();
    state.set(nodeId, "visited");
    return undefined;
  };

  for (const { nodeId } of nodes) {
    const cycle = visit(nodeId);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function bindingReferencesNode(
  binding: ValueBinding,
  targetNodeId: string,
): boolean {
  const reference = valueRefSchema.safeParse(binding);
  if (reference.success) return reference.data.nodeId === targetNodeId;
  if (Array.isArray(binding)) {
    return binding.some((value) => bindingReferencesNode(value, targetNodeId));
  }
  if (typeof binding !== "object" || binding === null) return false;
  return Object.values(binding).some((value) =>
    bindingReferencesNode(value, targetNodeId),
  );
}

function dependencyKind(node: PlanNode, dependency: string): string {
  if (
    node.type === "task" &&
    node.session?.type !== undefined &&
    node.session.type !== "isolated" &&
    node.session.from === dependency
  ) {
    return `session:${node.session.type}`;
  }
  return bindingReferencesNode(node.input, dependency)
    ? "dataflow"
    : "explicit";
}

function describeCycle(
  nodesById: ReadonlyMap<string, PlanNode>,
  cycle: readonly string[],
): string {
  return cycle
    .slice(0, -1)
    .map((nodeId, index) => {
      const dependency = cycle[index + 1];
      const node = nodesById.get(nodeId);
      return `${nodeId} --${node ? dependencyKind(node, dependency ?? "") : "unknown"}--> ${dependency}`;
    })
    .join("; ");
}

function validateRepeat(
  node: RepeatNode,
  issues: PlanValidationIssue[],
  outerNodeIds: ReadonlySet<string>,
  taskDefinitions: TaskDefinitionRegistry | undefined,
  validateDefinitions: boolean,
): void {
  if (
    !Number.isFinite(node.maximumIterations) ||
    !Number.isInteger(node.maximumIterations) ||
    node.maximumIterations < 1 ||
    node.maximumIterations > MAX_REPEAT_BODY_EXECUTIONS
  ) {
    addIssue(
      issues,
      "invalid-repeat-limit",
      `Repeat "${node.nodeId}" must have a positive integer maximumIterations from 1 through ${MAX_REPEAT_BODY_EXECUTIONS}`,
      node.nodeId,
    );
  }
  if (node.body.nodes.length === 0) {
    addIssue(
      issues,
      "empty-repeat-body",
      `Repeat "${node.nodeId}" must contain a body task`,
      node.nodeId,
    );
  }
  const bodyById = new Map<string, PlanNode>();
  for (const bodyNode of node.body.nodes) {
    if (bodyNode.nodeId.length === 0) {
      addIssue(
        issues,
        "empty-node-id",
        `Repeat body of "${node.nodeId}" contains a node with an empty ID`,
        node.nodeId,
      );
    } else if (
      bodyById.has(bodyNode.nodeId) ||
      outerNodeIds.has(bodyNode.nodeId)
    ) {
      addIssue(
        issues,
        "duplicate-node-id",
        `Duplicate repeat body node ID "${bodyNode.nodeId}"`,
        bodyNode.nodeId,
      );
    } else {
      bodyById.set(bodyNode.nodeId, bodyNode);
    }
  }
  const bodyNodeIds = new Set(bodyById.keys());
  const bodyScope = new Set([node.body.inputNodeId]);
  for (const bodyNodeId of bodyNodeIds) bodyScope.add(bodyNodeId);

  for (const bodyNode of node.body.nodes) {
    const dependencies = new Set<string>();
    for (const dependency of bodyNode.dependsOn) {
      if (dependencies.has(dependency)) {
        addIssue(
          issues,
          "duplicate-dependency",
          `Duplicate dependency "${dependency}" in "${bodyNode.nodeId}"`,
          bodyNode.nodeId,
        );
      }
      dependencies.add(dependency);
      if (dependency === bodyNode.nodeId) {
        addIssue(
          issues,
          "self-dependency",
          `Node "${bodyNode.nodeId}" has a self-dependency`,
          bodyNode.nodeId,
        );
      } else if (
        dependency !== node.body.inputNodeId &&
        !bodyNodeIds.has(dependency)
      ) {
        addIssue(
          issues,
          "invalid-repeat-body-reference",
          `Repeat body "${node.nodeId}" has an out-of-scope dependency "${dependency}"`,
          node.nodeId,
        );
      }
    }

    validateReferences(
      bodyNode.input,
      bodyNode,
      bodyById,
      issues,
      new Set([node.body.inputNodeId]),
      false,
      "invalid-repeat-body-reference",
    );
    if (bodyNode.type === "task") {
      validateTaskWorkspace(bodyNode, issues);
      validateTaskDefinition(
        bodyNode,
        taskDefinitions,
        issues,
        validateDefinitions,
      );
    }
    if (
      bodyNode.type === "validation.check" ||
      bodyNode.type === "validation.gate"
    ) {
      validateValidationNode(
        bodyNode,
        bodyById,
        issues,
        true,
        bodyNodeIds,
        taskDefinitions,
        validateDefinitions,
      );
    }
  }

  resolveSessionSelections(node.body.nodes, bodyById, issues);

  validateReferences(
    node.body.output,
    undefined,
    bodyById,
    issues,
    bodyScope,
    false,
    "invalid-repeat-body-reference",
  );

  const postconditionGates = node.body.nodes.filter(
    (
      bodyNode,
    ): bodyNode is Extract<ValidationNode, { type: "validation.gate" }> =>
      bodyNode.type === "validation.gate" &&
      bodyNode.policy === "repeat-postcondition",
  );
  for (const gate of postconditionGates) {
    if (node.body.nodes[node.body.nodes.length - 1]?.nodeId !== gate.nodeId) {
      addIssue(
        issues,
        "repeat-postcondition-not-final",
        `Repeat-postcondition gate "${gate.nodeId}" must be the final body node`,
        gate.nodeId,
      );
    }
  }
  if (postconditionGates.length > 1) {
    addIssue(
      issues,
      "invalid-repeat-postcondition",
      `Repeat "${node.nodeId}" must have exactly one repeat-postcondition gate`,
      node.nodeId,
    );
  }

  const until = node.body.until;
  const untilResult = valueRefSchema.safeParse(until);
  const untilNodeIdResult = untilResult.success
    ? valueRefNodeIdSchema.safeParse(untilResult.data.nodeId)
    : undefined;
  const untilPathResult = untilResult.success
    ? valueRefPathSchema.safeParse(untilResult.data.path)
    : undefined;
  const untilTarget = untilNodeIdResult?.success
    ? bodyById.get(untilNodeIdResult.data)
    : undefined;
  if (
    !untilResult.success ||
    !untilNodeIdResult?.success ||
    !untilPathResult?.success ||
    untilTarget === undefined ||
    untilPathResult.data.length === 0
  ) {
    addIssue(
      issues,
      "invalid-repeat-condition",
      `Repeat "${node.nodeId}" condition must reference a body result`,
      node.nodeId,
    );
  } else if (untilTarget.type === "validation.gate") {
    if (untilTarget.policy !== "repeat-postcondition") {
      addIssue(
        issues,
        "invalid-repeat-postcondition",
        `Repeat "${node.nodeId}" cannot use a fail validation gate as its condition`,
        node.nodeId,
      );
    } else if (
      untilPathResult.data.length !== 2 ||
      untilPathResult.data[0] !== "validation" ||
      untilPathResult.data[1] !== "success"
    ) {
      addIssue(
        issues,
        "invalid-repeat-postcondition",
        `Repeat "${node.nodeId}" postcondition must reference validation.success`,
        node.nodeId,
      );
    }
    if (
      postconditionGates.length !== 1 ||
      postconditionGates[0] !== untilTarget
    ) {
      addIssue(
        issues,
        "invalid-repeat-postcondition",
        `Repeat "${node.nodeId}" condition must reference its repeat-postcondition gate`,
        node.nodeId,
      );
    }
  } else if (untilTarget.type === "validation.check") {
    addIssue(
      issues,
      "invalid-repeat-condition",
      `Repeat "${node.nodeId}" condition must reference a validation gate, not a check`,
      node.nodeId,
    );
  }
  if (
    postconditionGates.length === 1 &&
    (!untilResult.success ||
      !untilNodeIdResult?.success ||
      untilNodeIdResult.data !== postconditionGates[0]?.nodeId)
  ) {
    addIssue(
      issues,
      "invalid-repeat-postcondition",
      `Repeat "${node.nodeId}" condition must reference its repeat-postcondition gate`,
      node.nodeId,
    );
  }

  const cycle = dependencyCycle(node.body.nodes, bodyById);
  if (cycle !== undefined) {
    addIssue(
      issues,
      "repeat-body-cycle",
      `Repeat body "${node.nodeId}" contains a dependency cycle: ${describeCycle(bodyById, cycle)}`,
      node.nodeId,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSemanticallyTraversableNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.type !== "string" ||
    typeof value.nodeId !== "string" ||
    !Array.isArray(value.dependsOn)
  ) {
    return false;
  }

  if (value.type === "validation.check") {
    return isRecord(value.source);
  }

  if (value.type !== "repeat") return true;
  return (
    isRecord(value.body) &&
    Array.isArray(value.body.nodes) &&
    value.body.nodes.every(isSemanticallyTraversableNode)
  );
}

function isSemanticallyTraversablePlan(value: unknown): value is Plan {
  return (
    isRecord(value) &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isSemanticallyTraversableNode)
  );
}

function validatePlanWithCanonicalIssues(
  plan: Plan,
  taskDefinitions?: TaskDefinitionRegistry,
  validateDefinitions = taskDefinitions !== undefined,
  canonicalIssues: readonly z.ZodIssue[] = [],
): void {
  const issues: PlanValidationIssue[] = [];
  const nodesById = new Map<string, PlanNode>();

  for (const node of plan.nodes) {
    if (node.nodeId.length === 0) {
      addIssue(
        issues,
        "empty-node-id",
        "Plan nodes must have non-empty IDs",
        node.nodeId,
      );
    }
    if (nodesById.has(node.nodeId)) {
      addIssue(
        issues,
        "duplicate-node-id",
        `Duplicate Plan node ID "${node.nodeId}"`,
        node.nodeId,
      );
    } else {
      nodesById.set(node.nodeId, node);
    }
  }

  for (const node of plan.nodes) {
    const dependencies = new Set<string>();
    for (const dependency of node.dependsOn) {
      if (dependencies.has(dependency)) {
        addIssue(
          issues,
          "duplicate-dependency",
          `Duplicate dependency "${dependency}" in "${node.nodeId}"`,
          node.nodeId,
        );
      }
      dependencies.add(dependency);

      if (dependency === node.nodeId) {
        addIssue(
          issues,
          "self-dependency",
          `Node "${node.nodeId}" has a self-dependency`,
          node.nodeId,
        );
      } else if (!nodesById.has(dependency)) {
        addIssue(
          issues,
          "unknown-dependency",
          `Unknown dependency "${dependency}" in "${node.nodeId}"`,
          node.nodeId,
        );
      }
    }

    validateReferences(node.input, node, nodesById, issues);
    if (node.type === "task") {
      validateTaskWorkspace(node, issues);
      validateTaskDefinition(
        node,
        taskDefinitions,
        issues,
        validateDefinitions,
      );
    }
    if (node.type === "validation.check" || node.type === "validation.gate") {
      validateValidationNode(
        node,
        nodesById,
        issues,
        false,
        undefined,
        taskDefinitions,
        validateDefinitions,
      );
    }
    if (node.type === "repeat") {
      validateRepeat(
        node,
        issues,
        new Set(nodesById.keys()),
        taskDefinitions,
        validateDefinitions,
      );
    }
  }

  resolveSessionSelections(plan.nodes, nodesById, issues);

  validateReferences(plan.output, undefined, nodesById, issues);

  const cycle =
    issues.length === 0 ? dependencyCycle(plan.nodes, nodesById) : undefined;
  if (cycle !== undefined) {
    addIssue(
      issues,
      "dependency-cycle",
      `Plan contains a dependency cycle: ${describeCycle(nodesById, cycle)}`,
    );
  }

  if (issues.length === 0) {
    for (const issue of canonicalIssues) {
      const nodeIndex = issue.path[1];
      addIssue(
        issues,
        "invalid-plan-schema",
        `Plan schema validation failed: ${issue.message}`,
        typeof nodeIndex === "number" && plan.nodes[nodeIndex]
          ? plan.nodes[nodeIndex].nodeId
          : undefined,
      );
    }
  }

  if (issues.length > 0) {
    throw new PlanValidationError(issues);
  }
}

/** Validate a Plan that has already passed the canonical core schema. */
export function validateParsedPlan(
  plan: Plan,
  taskDefinitions?: TaskDefinitionRegistry,
  validateDefinitions = taskDefinitions !== undefined,
): void {
  validatePlanWithCanonicalIssues(plan, taskDefinitions, validateDefinitions);
}

export function validatePlan(
  plan: Plan,
  taskDefinitions?: TaskDefinitionRegistry,
  validateDefinitions = taskDefinitions !== undefined,
): void {
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) {
    if (isSemanticallyTraversablePlan(plan)) {
      validatePlanWithCanonicalIssues(
        plan,
        taskDefinitions,
        validateDefinitions,
        parsed.error.issues,
      );
      return;
    }

    throw new PlanValidationError(
      parsed.error.issues.map(({ message }) => ({
        code: "invalid-plan-schema" as const,
        message: `Plan schema validation failed: ${message}`,
      })),
    );
  }

  validatePlanWithCanonicalIssues(
    parsed.data,
    taskDefinitions,
    validateDefinitions,
  );
}
