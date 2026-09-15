import type {
  Plan,
  PlanNode,
  RepeatNode,
  TaskDefinitionRegistry,
  TaskNode,
  ValidationNode,
  ValueBinding,
  WorkflowDefinitionRegistry,
  WorkflowNode,
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
  | "invalid-repeat-reference"
  | "repeat-body-cycle"
  | "repeat-postcondition-outside-body"
  | "repeat-postcondition-not-final"
  | "repeat-postcondition-check-out-of-scope"
  | "invalid-repeat-postcondition"
  | "invalid-validation-source"
  | "invalid-validation-policy"
  | "unknown-validation-check"
  | "validation-check-not-dependency"
  | "invalid-repeat-postcondition"
  | "invalid-workspace-policy"
  | "invalid-session-policy"
  | "invalid-session-model"
  | "session-model-conflict"
  | "invalid-session-source"
  | "missing-session-dependency"
  | "forbidden-permission-configuration"
  | "missing-task-definition"
  | "invalid-task-definition"
  | "missing-workflow-definition";

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

function validateWorkflowNode(
  node: WorkflowNode,
  workflowDefinitions: WorkflowDefinitionRegistry | undefined,
  issues: PlanValidationIssue[],
  validateDefinitions: boolean,
): void {
  if (!workspacePolicySchema.safeParse(node.workspace).success) {
    addIssue(
      issues,
      "invalid-workspace-policy",
      `Workflow "${node.nodeId}" must declare a valid workspace policy`,
      node.nodeId,
    );
  }
  if (validateDefinitions && !workflowDefinitions?.has(node.workflowId)) {
    addIssue(
      issues,
      "missing-workflow-definition",
      `Workflow "${node.nodeId}" has no registered definition for "${node.workflowId}"`,
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

function validateRepeatScopedReferences(
  binding: ValueBinding,
  repeatNodeId: string,
  allowedNodeIds: ReadonlySet<string>,
  issues: PlanValidationIssue[],
  attemptNodeId?: string,
  outerNodes?: ReadonlyMap<string, PlanNode>,
  declaredOuterDependencies?: ReadonlySet<string>,
): void {
  const reference = valueRefSchema.safeParse(binding);
  if (reference.success) {
    if (
      outerNodes?.has(reference.data.nodeId) === true &&
      reference.data.nodeId !== attemptNodeId &&
      !declaredOuterDependencies?.has(reference.data.nodeId)
    ) {
      addIssue(
        issues,
        "missing-value-ref-dependency",
        `Repeat "${repeatNodeId}" must list prior task dependency "${reference.data.nodeId}"`,
        repeatNodeId,
      );
    }
    if (
      !allowedNodeIds.has(reference.data.nodeId) ||
      (attemptNodeId !== undefined &&
        reference.data.nodeId === attemptNodeId &&
        reference.data.path[0] !== "output") ||
      (outerNodes?.has(reference.data.nodeId) === true &&
        reference.data.nodeId !== attemptNodeId &&
        !isValidRepeatOuterReference(
          outerNodes.get(reference.data.nodeId),
          reference.data.path,
        ))
    ) {
      addIssue(
        issues,
        "invalid-repeat-reference",
        `Repeat "${repeatNodeId}" contains an out-of-scope reference to "${reference.data.nodeId}"`,
        repeatNodeId,
      );
    }
    return;
  }
  if (Array.isArray(binding)) {
    for (const item of binding) {
      validateRepeatScopedReferences(
        item,
        repeatNodeId,
        allowedNodeIds,
        issues,
        attemptNodeId,
        outerNodes,
        declaredOuterDependencies,
      );
    }
    return;
  }
  if (typeof binding === "object" && binding !== null) {
    for (const item of Object.values(binding)) {
      validateRepeatScopedReferences(
        item,
        repeatNodeId,
        allowedNodeIds,
        issues,
        attemptNodeId,
        outerNodes,
        declaredOuterDependencies,
      );
    }
  }
}

function isValidRepeatOuterReference(
  node: PlanNode | undefined,
  path: readonly string[],
): boolean {
  const segment = path[0];
  if (node?.type === "validation.gate") {
    return segment === "value" || segment === "validation";
  }
  return (
    (node?.type === "task" ||
      node?.type === "workflow" ||
      node?.type === "repeat") &&
    segment === "output"
  );
}

function validateRepeat(
  node: RepeatNode,
  issues: PlanValidationIssue[],
  outerNodes: ReadonlyMap<string, PlanNode>,
  taskDefinitions: TaskDefinitionRegistry | undefined,
  workflowDefinitions: WorkflowDefinitionRegistry | undefined,
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

  const attempt = node.attempt;
  const attemptInputNodeId = `${node.nodeId}:input`;
  const allowedAttemptReferences = new Set([
    attemptInputNodeId,
    attempt.nodeId,
  ]);
  const outerNodeIds = [...outerNodes.keys()];
  const currentIndex = outerNodeIds.indexOf(node.nodeId);
  const priorOuterReferences = new Set(
    currentIndex < 0 ? [] : outerNodeIds.slice(0, currentIndex),
  );
  if (attempt.nodeId.length === 0 || outerNodes.has(attempt.nodeId)) {
    addIssue(
      issues,
      "duplicate-node-id",
      `Repeat attempt node ID "${attempt.nodeId}" is not unique`,
      node.nodeId,
    );
  }

  const dependencies = new Set<string>();
  for (const dependency of attempt.dependsOn) {
    if (dependencies.has(dependency)) {
      addIssue(
        issues,
        "duplicate-dependency",
        `Duplicate dependency "${dependency}" in repeat attempt "${attempt.nodeId}"`,
        attempt.nodeId,
      );
    }
    dependencies.add(dependency);
    if (dependency === attempt.nodeId) {
      addIssue(
        issues,
        "self-dependency",
        `Repeat attempt "${attempt.nodeId}" has a self-dependency`,
        attempt.nodeId,
      );
    } else if (!outerNodes.has(dependency)) {
      addIssue(
        issues,
        "invalid-repeat-reference",
        `Repeat attempt "${attempt.nodeId}" has an out-of-scope dependency "${dependency}"`,
        attempt.nodeId,
      );
    } else if (!node.dependsOn.includes(dependency)) {
      addIssue(
        issues,
        "missing-value-ref-dependency",
        `Repeat "${node.nodeId}" must list attempt dependency "${dependency}"`,
        node.nodeId,
      );
    }
  }

  validateRepeatScopedReferences(
    attempt.input,
    node.nodeId,
    new Set([attemptInputNodeId]),
    issues,
  );
  const attemptInput = valueRefSchema.safeParse(attempt.input);
  if (
    !attemptInput.success ||
    attemptInput.data.nodeId !== attemptInputNodeId ||
    attemptInput.data.path.length !== 0
  ) {
    addIssue(
      issues,
      "invalid-repeat-reference",
      `Repeat attempt "${attempt.nodeId}" must read its reserved attempt input`,
      attempt.nodeId,
    );
  }

  if (attempt.type === "task") {
    validateTaskWorkspace(attempt, issues);
    validateTaskDefinition(
      attempt,
      taskDefinitions,
      issues,
      validateDefinitions,
    );
  } else {
    validateWorkflowNode(
      attempt,
      workflowDefinitions,
      issues,
      validateDefinitions,
    );
  }

  if (attempt.type === "task" && attempt.session !== undefined) {
    const session = planSessionPolicySchema.safeParse(attempt.session);
    if (!session.success) {
      addIssue(
        issues,
        "invalid-session-policy",
        `Repeat attempt "${attempt.nodeId}" must declare a valid session policy`,
        attempt.nodeId,
      );
    } else if (session.data.type !== "isolated") {
      const source = outerNodes.get(session.data.from);
      if (source?.type !== "task") {
        addIssue(
          issues,
          "invalid-session-source",
          `Repeat attempt "${attempt.nodeId}" session source "${session.data.from}" must be an agent task`,
          attempt.nodeId,
        );
      }
      if (!attempt.dependsOn.includes(session.data.from)) {
        addIssue(
          issues,
          "missing-session-dependency",
          `Repeat attempt "${attempt.nodeId}" must depend on session source "${session.data.from}"`,
          attempt.nodeId,
        );
      }
    }
    const selections = new Map<string, PlanNode>(outerNodes);
    selections.set(attempt.nodeId, attempt);
    resolveSessionSelections([attempt], selections, issues);
  }

  const condition = valueRefSchema.safeParse(node.until);
  const conditionIsAttemptResult =
    condition.success &&
    condition.data.nodeId === attempt.nodeId &&
    condition.data.path.length > 0 &&
    condition.data.path[0] === "output";
  if (
    condition.success &&
    priorOuterReferences.has(condition.data.nodeId) &&
    !node.dependsOn.includes(condition.data.nodeId)
  ) {
    addIssue(
      issues,
      "missing-value-ref-dependency",
      `Repeat "${node.nodeId}" must list prior task dependency "${condition.data.nodeId}"`,
      node.nodeId,
    );
  }
  const conditionIsPriorOutput =
    condition.success &&
    priorOuterReferences.has(condition.data.nodeId) &&
    node.dependsOn.includes(condition.data.nodeId) &&
    isValidRepeatOuterReference(
      outerNodes.get(condition.data.nodeId),
      condition.data.path,
    );
  if (
    !condition.success ||
    (!conditionIsAttemptResult && !conditionIsPriorOutput)
  ) {
    addIssue(
      issues,
      "invalid-repeat-condition",
      `Repeat "${node.nodeId}" condition must reference its attempt or a prior task output`,
      node.nodeId,
    );
  }

  if (node.nextInput !== undefined) {
    validateRepeatScopedReferences(
      node.nextInput,
      node.nodeId,
      new Set([...allowedAttemptReferences, ...priorOuterReferences]),
      issues,
      attempt.nodeId,
      outerNodes,
      new Set(node.dependsOn),
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
    isRecord(value.attempt) && isSemanticallyTraversableNode(value.attempt)
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
  workflowDefinitions?: WorkflowDefinitionRegistry,
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
    if (node.type === "workflow") {
      validateWorkflowNode(
        node,
        workflowDefinitions,
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
        nodesById,
        taskDefinitions,
        workflowDefinitions,
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
  workflowDefinitions?: WorkflowDefinitionRegistry,
): void {
  validatePlanWithCanonicalIssues(
    plan,
    taskDefinitions,
    workflowDefinitions,
    validateDefinitions,
  );
}

export function validatePlan(
  plan: Plan,
  taskDefinitions?: TaskDefinitionRegistry,
  validateDefinitions = taskDefinitions !== undefined,
  workflowDefinitions?: WorkflowDefinitionRegistry,
): Plan {
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) {
    if (isSemanticallyTraversablePlan(plan)) {
      validatePlanWithCanonicalIssues(
        plan,
        taskDefinitions,
        workflowDefinitions,
        validateDefinitions,
        parsed.error.issues,
      );
      return plan;
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
    workflowDefinitions,
    validateDefinitions,
  );
  return parsed.data;
}
