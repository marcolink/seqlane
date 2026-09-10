import { taskDefinitionSchema } from "./contracts.js";
import type {
  TaskDefinition,
  TaskInvocationOptions,
  TaskId,
  Validator,
  ValidatorDefinition,
  ValidationInvocationOptions,
  WorkflowDefinition,
  RepeatBodyContext,
  RepeatBuildOptions,
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
  Plan,
  PlanNode,
  PlanSessionPolicy,
  TaskNode,
  ValidationGatePolicy,
  ValidationNode,
  ValidationSource,
} from "./plan-types.js";
import { planSchema } from "./plan-types.js";
import {
  taskDefinitionRegistrySchema,
  validatorDefinitionRegistrySchema,
} from "./contracts.js";
import { getWorkflowPlanBuilder } from "./workflow-internal.js";

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
    type: resolved.type,
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

export function buildWorkflow<Input, Output>(
  workflow: WorkflowDefinition<Input, Output>,
): BuiltWorkflow<Input, Output> {
  const workflowBuilder = getWorkflowPlanBuilder(workflow);
  if (workflowBuilder === undefined) {
    throw new TypeError(
      `Workflow "${workflow.id}" was not created by createFlow(...).output(...).define()`,
    );
  }
  const nodes: PlanNode[] = [];
  const invocationCounts = new Map<TaskId, number>();
  const validationCounts = new Map<string, number>();
  let repeatCount = 0;
  const taskDefinitions = new Map<TaskId, TaskDefinition<unknown, unknown>>();
  const validatorDefinitions = new Map<string, ValidatorDefinition<unknown>>();

  function run<
    TaskInput,
    TaskOutput,
    Options extends TaskInvocationOptions<TaskInput, TaskOutput>,
  >(
    task: TaskDefinition<TaskInput, TaskOutput>,
    options: Options,
  ): TaskInvocation<TaskOutput, Options["session"]> {
    taskDefinitionSchema.parse(task);
    const count = (invocationCounts.get(task.id) ?? 0) + 1;
    invocationCounts.set(task.id, count);
    const nodeId = `${task.id}:${count}`;
    const dependencies = new Set<string>();

    collectDependencies(options.input, dependencies);
    for (const dependency of options.dependsOn ?? []) {
      dependencies.add(dependency.nodeId);
    }
    const session = serializeSessionPolicy(options.session);
    if (session !== undefined && session.type !== "isolated") {
      dependencies.add(session.from);
    }
    registerTaskDefinition(taskDefinitions, task);
    nodes.push({
      type: "task",
      taskId: task.id,
      nodeId,
      workspace: options.workspace ?? "exclusive",
      ...(session === undefined ? {} : { session }),
      input: serializeBinding(options.input),
      dependsOn: [...dependencies],
    });

    const output = createValueRef<TaskOutput>(nodeId, ["output"]);
    if (options.validateOutput !== undefined) {
      const validation = validate(options.validateOutput, { input: output });
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
    const validationNumber = (validationCounts.get(nodePrefix) ?? 0) + 1;
    validationCounts.set(nodePrefix, validationNumber);
    const checkNodeId = `${nodePrefix}.check:${validationNumber}`;
    const gateNodeId = `${nodePrefix}.gate:${validationNumber}`;
    const checkDependencies = new Set<string>();
    const serializedInput = serializeBinding(options.input);

    collectDependencies(options.input, checkDependencies);

    let source: ValidationSource;
    if ("validate" in validator) {
      const existing = validatorDefinitions.get(validator.id);
      if (existing !== undefined && existing !== validator) {
        throw new Error(`Duplicate validator definition "${validator.id}"`);
      }
      validatorDefinitions.set(validator.id, validator);
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

  const repeat = <State>(
    options: RepeatBuildOptions<State>,
  ): MechanicalTaskRef<State> => {
    const nodeId = `repeat:${(repeatCount += 1)}`;
    const dependencies = new Set<string>();
    collectDependencies(options.initial, dependencies);
    const bodyNodes: (TaskNode | ValidationNode)[] = [];
    const bodyCounts = new Map<TaskId, number>();
    const bodyValidationPrefix = `${nodeId}/validation`;
    const bodyInput = createValueRef<State>(`${nodeId}:input`);
    function bodyTask<
      TaskInput,
      TaskOutput,
      Options extends Omit<
        TaskInvocationOptions<TaskInput, TaskOutput>,
        "validateOutput"
      >,
    >(
      task: TaskDefinition<TaskInput, TaskOutput>,
      taskOptions: Options,
    ): TaskInvocation<TaskOutput, Options["session"]> {
      taskDefinitionSchema.parse(task);
      const count = (bodyCounts.get(task.id) ?? 0) + 1;
      bodyCounts.set(task.id, count);
      const bodyNodeId = `${nodeId}/${task.id}:${count}`;
      const bodyDependencies = new Set<string>();
      collectDependencies(taskOptions.input, bodyDependencies);
      for (const dependency of taskOptions.dependsOn ?? []) {
        bodyDependencies.add(dependency.nodeId);
      }
      const session = serializeSessionPolicy(taskOptions.session);
      if (session !== undefined && session.type !== "isolated") {
        bodyDependencies.add(session.from);
      }
      registerTaskDefinition(taskDefinitions, task);
      bodyNodes.push({
        type: "task",
        taskId: task.id,
        nodeId: bodyNodeId,
        workspace: taskOptions.workspace ?? "exclusive",
        ...(session === undefined ? {} : { session }),
        input: serializeBinding(taskOptions.input),
        dependsOn: [...bodyDependencies],
      });
      const output = createValueRef<TaskOutput>(bodyNodeId, ["output"]);
      return (
        session === undefined
          ? { nodeId: bodyNodeId, output }
          : {
              nodeId: bodyNodeId,
              output,
              session: createSessionCheckpointRef(bodyNodeId),
            }
      ) as TaskInvocation<TaskOutput, Options["session"]>;
    }
    const bodyValidate = <Candidate>(
      validator: Validator<Candidate>,
      validationOptions: ValidationInvocationOptions<Candidate>,
      policy: ValidationGatePolicy = "fail",
    ): ValidationInvocation<Candidate> =>
      validate(
        validator,
        validationOptions,
        bodyNodes,
        policy,
        bodyValidationPrefix,
      );
    const bodyContext: RepeatBodyContext<State> = {
      input: bodyInput,
      task: bodyTask,
      validate: bodyValidate,
    };
    const bodyOutput = options.body(bodyContext);
    let output = bodyOutput;
    let until: ValueRef<boolean>;
    if (typeof options.until === "function") {
      until = options.until({ output: bodyOutput });
    } else {
      const postcondition = bodyValidate(
        options.until.validator,
        {
          input: bodyOutput,
        },
        "repeat-postcondition",
      );
      output = postcondition.output;
      until = postcondition.result.success;
    }
    nodes.push({
      type: "repeat",
      nodeId,
      input: serializeBinding(options.initial),
      dependsOn: [...dependencies],
      maximumIterations: options.maximumIterations,
      body: {
        inputNodeId: `${nodeId}:input`,
        nodes: bodyNodes,
        output: serializeBinding(output),
        until: serializeBinding(until) as ValueRef<boolean>,
      },
    });
    return { nodeId, output: createValueRef<State>(nodeId, ["output"]) };
  };

  const output = workflowBuilder({
    input: createWorkflowInputRef<Input>(),
    run,
    validate,
    repeat,
  });

  const plan: Plan = {
    workflow: { id: workflow.id },
    nodes,
    output: serializeBinding(output),
  };
  planSchema.parse(plan);
  taskDefinitionRegistrySchema.parse(taskDefinitions);
  validatorDefinitionRegistrySchema.parse(validatorDefinitions);

  return {
    workflow,
    plan,
    taskDefinitions,
    validatorDefinitions,
  };
}
