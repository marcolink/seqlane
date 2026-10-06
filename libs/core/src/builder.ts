import { taskDefinitionSchema } from "./contracts.js";
import type {
  TaskDefinition,
  TaskInvocationOptions,
  TaskId,
  Validator,
  ValidatorDefinition,
  ValidationInvocationOptions,
  AuthoredWorkflow,
  RunnableDefinition,
} from "./contracts.js";
import {
  collectDependencies,
  createSessionCheckpointRef,
  createValueRef,
  createWorkflowInputRef,
  sessionCheckpointNodeId,
  serializeBinding,
  type MechanicalTaskRef,
  type TaskInvocation,
  type ValidationInvocation,
  type ValueRef,
} from "./bindings.js";
import type {
  BuiltWorkflow,
  ChoiceNode,
  Plan,
  PlanNode,
  PlanSessionPolicy,
  RepeatNode,
  RunnableNode,
  OutputValidation,
  ValidationGatePolicy,
  ValidationSource,
} from "./plan-types.js";
import { planSchema } from "./plan-types.js";
import {
  taskDefinitionRegistrySchema,
  validatorDefinitionRegistrySchema,
} from "./contracts.js";
import {
  getWorkflowPlanBuilder,
  isAuthoredWorkflow,
} from "./workflow-internal.js";
import type {
  ChoiceArmBuildOptions,
  ChoiceBuildOptions,
  RepeatBuildOptions,
  RunnableBuildOptions,
  WorkflowInvocationOptions,
} from "./workflow-authoring-internal.js";

function serializeSessionPolicy(
  policy: TaskInvocationOptions<unknown, unknown>["session"],
): PlanSessionPolicy | undefined {
  const resolved = policy;
  if (resolved === undefined) return undefined;
  if (resolved.type === "isolated") return resolved;
  if (resolved.type === "reuse") {
    return {
      type: resolved.type,
      from: sessionCheckpointNodeId(resolved.from),
    };
  }
  return {
    type: "fork",
    from: sessionCheckpointNodeId(resolved.from),
    ...(resolved.model === undefined ? {} : { model: resolved.model }),
  };
}

function registerTaskDefinition(
  taskDefinitions: Map<TaskId, TaskDefinition<unknown, unknown>>,
  task: TaskDefinition<unknown, unknown>,
): void {
  const existing = taskDefinitions.get(task.id);
  if (existing !== undefined && existing !== task) {
    throw new Error(`Duplicate task definition "${task.id}"`);
  }
  taskDefinitions.set(task.id, task);
}

function registerValidatorDefinition(
  definitions: Map<string, ValidatorDefinition<unknown>>,
  validator: ValidatorDefinition<unknown>,
): void {
  const existing = definitions.get(validator.id);
  if (existing !== undefined && existing !== validator) {
    throw new Error(`Duplicate validator definition "${validator.id}"`);
  }
  definitions.set(validator.id, validator);
}

function registerWorkflowDefinition(
  workflowDefinitions: Map<string, BuiltWorkflow<unknown, unknown>>,
  workflow: AuthoredWorkflow<unknown, unknown>,
  building: ReadonlySet<string>,
): BuiltWorkflow<unknown, unknown> {
  if (building.has(workflow.id)) {
    throw new Error(`Cyclic workflow composition at "${workflow.id}"`);
  }
  const built = buildWorkflowInternal(
    workflow,
    new Set([...building, workflow.id]),
  );
  const existing = workflowDefinitions.get(workflow.id);
  if (existing !== undefined && existing.workflow !== workflow) {
    throw new Error(`Duplicate workflow definition "${workflow.id}"`);
  }
  workflowDefinitions.set(workflow.id, built);
  for (const [id, nested] of built.workflowDefinitions) {
    const nestedExisting = workflowDefinitions.get(id);
    if (
      nestedExisting !== undefined &&
      nestedExisting.workflow !== nested.workflow
    ) {
      throw new Error(`Duplicate workflow definition "${id}"`);
    }
    workflowDefinitions.set(id, nested);
  }
  return built;
}

interface RunnableConstructionContext {
  readonly building: ReadonlySet<string>;
  readonly taskDefinitions: Map<TaskId, TaskDefinition<unknown, unknown>>;
  readonly validatorDefinitions: Map<string, ValidatorDefinition<unknown>>;
  readonly workflowDefinitions: Map<string, BuiltWorkflow<unknown, unknown>>;
}

function registerOutputValidation<TaskOutput>(
  validator: import("./contracts.js").Validator<TaskOutput> | undefined,
  context: RunnableConstructionContext,
): OutputValidation | undefined {
  if (validator === undefined) return undefined;
  if ("validate" in validator) {
    registerValidatorDefinition(context.validatorDefinitions, validator);
    return { source: { type: "mechanical", validatorId: validator.id } };
  }
  registerTaskDefinition(context.taskDefinitions, validator);
  return {
    source: {
      type: "task",
      taskId: validator.id,
      workspace: "exclusive",
    },
  };
}

function registerNestedDefinitions(
  nested: BuiltWorkflow<unknown, unknown>,
  context: RunnableConstructionContext,
): void {
  for (const definition of nested.taskDefinitions.values()) {
    registerTaskDefinition(context.taskDefinitions, definition);
  }
  for (const definition of nested.validatorDefinitions.values()) {
    registerValidatorDefinition(context.validatorDefinitions, definition);
  }
}

/** Construct one runnable; callers decide which dependencies gate their topology. */
function buildRunnableNode<Input, Output>(
  nodeId: string,
  options: RunnableBuildOptions<Input, Output>,
  context: RunnableConstructionContext,
): {
  readonly node: RunnableNode;
  readonly eligibilityDependencies: readonly string[];
} {
  const dependencies = new Set<string>();
  collectDependencies(options.input, dependencies);
  for (const dependency of options.dependsOn ?? [])
    dependencies.add(dependency.nodeId);
  const eligibilityDependencies = [...dependencies];
  const common = {
    nodeId,
    workspace: options.workspace ?? "exclusive",
  };
  if (isAuthoredWorkflow(options.runnable)) {
    const nested = registerWorkflowDefinition(
      context.workflowDefinitions,
      options.runnable,
      context.building,
    );
    registerNestedDefinitions(nested, context);
    return {
      eligibilityDependencies,
      node: {
        type: "workflow",
        workflowId: options.runnable.id,
        ...common,
        input: serializeBinding(options.input),
        dependsOn: [...dependencies],
      },
    };
  }
  taskDefinitionSchema.parse(options.runnable);
  const session = serializeSessionPolicy(options.session);
  if (session !== undefined && session.type !== "isolated")
    dependencies.add(session.from);
  registerTaskDefinition(context.taskDefinitions, options.runnable);
  return {
    eligibilityDependencies,
    node: {
      type: "task",
      taskId: options.runnable.id,
      ...common,
      ...(session === undefined ? {} : { session }),
      input: serializeBinding(options.input),
      dependsOn: [...dependencies],
    },
  };
}

function buildRepeatAttempt<TaskInput, TaskOutput>(
  nodeId: string,
  options: RepeatBuildOptions<TaskInput, TaskOutput>,
  context: RunnableConstructionContext,
): { readonly attempt: RunnableNode; readonly dependencies: Set<string> } {
  const inputNodeId = `${nodeId}:input`;
  const built = buildRunnableNode(
    `${nodeId}:attempt`,
    {
      ...options,
      input: createValueRef<TaskInput>(inputNodeId),
    },
    context,
  );
  // The attempt input is local to the repeat, not an external dependency.
  const dependencies = built.node.dependsOn.filter((id) => id !== inputNodeId);
  return {
    attempt: { ...built.node, dependsOn: dependencies },
    dependencies: new Set(dependencies),
  };
}

function buildRepeatNode<TaskInput, TaskOutput>(
  nodeId: string,
  options: RepeatBuildOptions<TaskInput, TaskOutput>,
  context: RunnableConstructionContext,
): {
  readonly node: RepeatNode;
  readonly output: MechanicalTaskRef<TaskOutput>;
} {
  const attemptInputNodeId = `${nodeId}:input`;
  const attemptNodeId = `${nodeId}:attempt`;
  const { attempt, dependencies: attemptDependencies } = buildRepeatAttempt(
    nodeId,
    options,
    context,
  );
  const dependencies = new Set<string>();
  collectDependencies(options.initial, dependencies);
  for (const dependency of options.dependsOn ?? []) {
    dependencies.add(dependency.nodeId);
  }
  for (const dependency of attemptDependencies) {
    dependencies.add(dependency);
  }
  const attemptInput = createValueRef<TaskInput>(attemptInputNodeId);
  const result = createValueRef<TaskOutput>(attemptNodeId, ["output"]);
  const until = options.until({ result });
  const nextInput = options.nextInput?.({ input: attemptInput, result });
  const validation = registerOutputValidation(options.validateOutput, context);
  const repeatBindingDependencies = new Set<string>();
  collectDependencies(until, repeatBindingDependencies);
  if (nextInput !== undefined) {
    collectDependencies(nextInput, repeatBindingDependencies);
  }
  for (const dependency of repeatBindingDependencies) {
    if (dependency !== attemptInputNodeId && dependency !== attemptNodeId) {
      dependencies.add(dependency);
    }
  }
  const node: RepeatNode = {
    type: "repeat",
    nodeId,
    input: serializeBinding(options.initial),
    dependsOn: [...dependencies],
    maximumIterations: options.maxIterations,
    attempt,
    until: serializeBinding(until) as ValueRef<boolean>,
    ...(validation === undefined ? {} : { validation }),
    ...(nextInput === undefined
      ? {}
      : { nextInput: serializeBinding(nextInput) }),
  };
  return {
    node,
    output: { nodeId, output: createValueRef(nodeId, ["output"]) },
  };
}

function buildChoiceArm<Input, Output>(
  nodeId: string,
  options: ChoiceArmBuildOptions<Input, Output>,
  context: RunnableConstructionContext,
): {
  readonly node: RunnableNode;
  readonly eligibilityDependencies: readonly string[];
  readonly validation?: OutputValidation;
} {
  if (
    isAuthoredWorkflow(options.runnable) &&
    (options.session !== undefined || options.validateOutput !== undefined)
  ) {
    throw new TypeError("Workflow choice arms do not accept task options");
  }
  const built = buildRunnableNode(nodeId, options, context);
  return {
    ...built,
    ...(options.validateOutput === undefined
      ? {}
      : {
          validation: registerOutputValidation(options.validateOutput, context),
        }),
  };
}

function buildChoiceNode<TrueInput, TrueOutput, FalseInput, FalseOutput>(
  nodeId: string,
  options: ChoiceBuildOptions<TrueInput, TrueOutput, FalseInput, FalseOutput>,
  context: RunnableConstructionContext,
): {
  readonly node: ChoiceNode;
  readonly output: MechanicalTaskRef<TrueOutput | FalseOutput>;
} {
  const thenArm = buildChoiceArm(`${nodeId}:then`, options.then, context);
  const elseArm = buildChoiceArm(`${nodeId}:else`, options.else, context);
  const dependencies = new Set<string>();
  collectDependencies(options.condition, dependencies);
  for (const arm of [thenArm, elseArm]) {
    for (const dependency of arm.eligibilityDependencies) {
      dependencies.add(dependency);
    }
  }
  return {
    node: {
      type: "choice",
      nodeId,
      condition: serializeBinding(options.condition) as ValueRef<boolean>,
      then: thenArm.node,
      else: elseArm.node,
      dependsOn: [...dependencies],
      ...(thenArm.validation === undefined && elseArm.validation === undefined
        ? {}
        : {
            validation: {
              ...(thenArm.validation === undefined
                ? {}
                : { then: thenArm.validation }),
              ...(elseArm.validation === undefined
                ? {}
                : { else: elseArm.validation }),
            },
          }),
    },
    output: { nodeId, output: createValueRef(nodeId, ["output"]) },
  };
}

export function buildWorkflow<Input, Output>(
  workflow: AuthoredWorkflow<Input, Output>,
): BuiltWorkflow<Input, Output> {
  return buildWorkflowInternal(workflow, new Set([workflow.id]));
}

function buildWorkflowInternal<Input, Output>(
  workflow: AuthoredWorkflow<Input, Output>,
  building: ReadonlySet<string>,
): BuiltWorkflow<Input, Output> {
  const workflowBuilder = getWorkflowPlanBuilder(workflow);
  if (workflowBuilder === undefined) {
    throw new TypeError(
      `Workflow "${workflow.id}" was not created by createFlow(...).output(...).define()`,
    );
  }
  const nodes: PlanNode[] = [];
  const nodeCounts = new Map<string, number>();
  const nextNodeId = (prefix: string): string => {
    const count = (nodeCounts.get(prefix) ?? 0) + 1;
    nodeCounts.set(prefix, count);
    return `${prefix}:${count}`;
  };
  const taskDefinitions = new Map<TaskId, TaskDefinition<unknown, unknown>>();
  const validatorDefinitions = new Map<string, ValidatorDefinition<unknown>>();
  const workflowDefinitions = new Map<
    string,
    BuiltWorkflow<unknown, unknown>
  >();

  const constructionContext: RunnableConstructionContext = {
    building,
    taskDefinitions,
    validatorDefinitions,
    workflowDefinitions,
  };

  function run<
    TaskInput,
    TaskOutput,
    Options extends TaskInvocationOptions<TaskInput, TaskOutput>,
  >(
    task: RunnableDefinition<TaskInput, TaskOutput>,
    options: Options | WorkflowInvocationOptions<TaskInput>,
  ): TaskInvocation<TaskOutput, Options["session"]> {
    const taskOptions = options as Options;
    const nodeId = nextNodeId(task.id);
    const { node } = buildRunnableNode(
      nodeId,
      { ...taskOptions, runnable: task },
      constructionContext,
    );
    nodes.push(node);
    if (node.type === "workflow") {
      return {
        nodeId,
        output: createValueRef<TaskOutput>(nodeId, ["output"]),
      } as TaskInvocation<TaskOutput, Options["session"]>;
    }
    const session = node.session;

    const output = createValueRef<TaskOutput>(nodeId, ["output"]);
    if (taskOptions.validateOutput !== undefined) {
      const validation = validate(taskOptions.validateOutput, {
        input: output,
      });
      return (
        session === undefined
          ? { nodeId, output: validation.output }
          : {
              nodeId,
              output: validation.output,
              session: createSessionCheckpointRef(nodeId),
            }
      ) as TaskInvocation<TaskOutput, Options["session"]>;
    }

    return (
      session === undefined
        ? { nodeId, output }
        : { nodeId, output, session: createSessionCheckpointRef(nodeId) }
    ) as TaskInvocation<TaskOutput, Options["session"]>;
  }

  const validate = <Candidate>(
    validator: Validator<Candidate>,
    options: ValidationInvocationOptions<Candidate>,
    targetNodes: PlanNode[] = nodes,
    policy: ValidationGatePolicy = "fail",
    nodePrefix = "validation",
  ): ValidationInvocation<Candidate> => {
    const checkNodeId = nextNodeId(`${nodePrefix}.check`);
    const gateNodeId = nextNodeId(`${nodePrefix}.gate`);
    const checkDependencies = new Set<string>();
    const serializedInput = serializeBinding(options.input);

    collectDependencies(options.input, checkDependencies);

    let source: ValidationSource;
    if ("validate" in validator) {
      registerValidatorDefinition(validatorDefinitions, validator);
      source = { type: "mechanical", validatorId: validator.id };
    } else {
      registerTaskDefinition(taskDefinitions, validator);
      source = {
        type: "task",
        taskId: validator.id,
        workspace: options.workspace ?? "exclusive",
      };
    }

    targetNodes.push({
      type: "validation.check",
      nodeId: checkNodeId,
      source,
      input: serializedInput,
      dependsOn: [...checkDependencies],
    });

    const gateDependencies = new Set(checkDependencies);
    gateDependencies.add(checkNodeId);
    targetNodes.push({
      type: "validation.gate",
      nodeId: gateNodeId,
      input: serializedInput,
      checkNodeId,
      policy,
      dependsOn: [...gateDependencies],
    });

    return {
      nodeId: gateNodeId,
      output: createValueRef<Candidate>(gateNodeId, ["value"]),
      result: createValueRef(gateNodeId, ["validation"]),
    };
  };

  const repeat = <TaskInput, TaskOutput>(
    options: RepeatBuildOptions<TaskInput, TaskOutput>,
  ): MechanicalTaskRef<TaskOutput> => {
    const nodeId = nextNodeId("repeat");
    const built = buildRepeatNode(nodeId, options, constructionContext);
    nodes.push(built.node);
    return built.output;
  };

  const choose = <TrueInput, TrueOutput, FalseInput, FalseOutput>(
    options: ChoiceBuildOptions<TrueInput, TrueOutput, FalseInput, FalseOutput>,
  ): MechanicalTaskRef<TrueOutput | FalseOutput> => {
    const nodeId = nextNodeId("choice");
    const built = buildChoiceNode(nodeId, options, constructionContext);
    nodes.push(built.node);
    return built.output;
  };

  const output = workflowBuilder({
    input: createWorkflowInputRef<Input>(),
    run,
    validate,
    repeat,
    choose,
  });

  const plan: Plan = {
    workflow: {
      id: workflow.id,
      ...(workflow.model === undefined ? {} : { model: workflow.model }),
    },
    nodes,
    output: serializeBinding(output),
  };
  const canonicalPlan = planSchema.parse(plan);
  taskDefinitionRegistrySchema.parse(taskDefinitions);
  validatorDefinitionRegistrySchema.parse(validatorDefinitions);

  return {
    workflow,
    plan: canonicalPlan,
    taskDefinitions,
    validatorDefinitions,
    workflowDefinitions,
  };
}
