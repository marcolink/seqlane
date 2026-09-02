import type {
  TaskDefinition,
  TaskId,
  TaskInvocationOptions,
  Validator,
  ValidatorDefinition,
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
  type InputBinding,
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
import { isolated } from "./dsl.js";

function serializeSessionPolicy(
  policy: TaskInvocationOptions<unknown, unknown>["session"],
): PlanSessionPolicy {
  const resolved = policy ?? isolated();
  if (resolved.type === "isolated") return resolved;
  return { type: resolved.type, from: sessionCheckpointNodeId(resolved.from) };
}

export function buildWorkflow<Input, Output>(
  workflow: WorkflowDefinition<Input, Output>,
): BuiltWorkflow<Input, Output> {
  const nodes: PlanNode[] = [];
  const invocationCounts = new Map<TaskId, number>();
  const validationCounts = new Map<string, number>();
  let repeatCount = 0;
  const taskDefinitions = new Map<TaskId, TaskDefinition>();
  const validatorDefinitions = new Map<string, ValidatorDefinition>();

  const run = <TaskInput, TaskOutput>(
    task: TaskDefinition<TaskInput, TaskOutput>,
    options: TaskInvocationOptions<TaskInput, TaskOutput>,
  ): TaskInvocation<TaskOutput> => {
    const count = (invocationCounts.get(task.id) ?? 0) + 1;
    invocationCounts.set(task.id, count);
    const nodeId = `${task.id}:${count}`;
    const dependencies = new Set<string>();

    collectDependencies(options.input, dependencies);
    for (const dependency of options.dependsOn ?? []) {
      dependencies.add(dependency.nodeId);
    }
    const session = serializeSessionPolicy(options.session);
    if (session.type !== "isolated") dependencies.add(session.from);
    taskDefinitions.set(task.id, task as unknown as TaskDefinition);
    nodes.push({
      type: "task",
      taskId: task.id,
      nodeId,
      workspace: task.workspace ?? "exclusive",
      session,
      input: serializeBinding(options.input),
      dependsOn: [...dependencies],
    });

    const output = createValueRef<TaskOutput>(nodeId, ["output"]);
    if (options.validateOutput !== undefined) {
      const validation = validate(options.validateOutput, { input: output });
      return {
        nodeId,
        output: validation.output,
        session: createSessionCheckpointRef(nodeId),
      };
    }

    return {
      nodeId,
      output,
      session: createSessionCheckpointRef(nodeId),
    };
  };

  const validate = <Candidate>(
    validator: Validator<Candidate>,
    options: { readonly input: InputBinding<Candidate> },
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
    if ("validate" in validator && typeof validator.validate === "function") {
      const existing = validatorDefinitions.get(validator.id);
      if (existing !== undefined && existing !== validator) {
        throw new Error(`Duplicate validator definition "${validator.id}"`);
      }
      validatorDefinitions.set(
        validator.id,
        validator as unknown as ValidatorDefinition,
      );
      source = { type: "mechanical", validatorId: validator.id };
    } else {
      taskDefinitions.set(validator.id, validator as unknown as TaskDefinition);
      source = {
        type: "task",
        taskId: validator.id,
        workspace: (validator as TaskDefinition).workspace ?? "exclusive",
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
    const bodyTask = <TaskInput, TaskOutput>(
      task: TaskDefinition<TaskInput, TaskOutput>,
      taskOptions: Omit<
        TaskInvocationOptions<TaskInput, TaskOutput>,
        "validateOutput"
      >,
    ): TaskInvocation<TaskOutput> => {
      const count = (bodyCounts.get(task.id) ?? 0) + 1;
      bodyCounts.set(task.id, count);
      const bodyNodeId = `${nodeId}/${task.id}:${count}`;
      const bodyDependencies = new Set<string>();
      collectDependencies(taskOptions.input, bodyDependencies);
      for (const dependency of taskOptions.dependsOn ?? []) {
        bodyDependencies.add(dependency.nodeId);
      }
      const session = serializeSessionPolicy(taskOptions.session);
      if (session.type !== "isolated") bodyDependencies.add(session.from);
      taskDefinitions.set(task.id, task as unknown as TaskDefinition);
      bodyNodes.push({
        type: "task",
        taskId: task.id,
        nodeId: bodyNodeId,
        workspace: task.workspace ?? "exclusive",
        session,
        input: serializeBinding(taskOptions.input),
        dependsOn: [...bodyDependencies],
      });
      return {
        nodeId: bodyNodeId,
        output: createValueRef(bodyNodeId, ["output"]),
        session: createSessionCheckpointRef(bodyNodeId),
      };
    };
    const bodyValidate = <Candidate>(
      validator: Validator<Candidate>,
      validationOptions: { readonly input: InputBinding<Candidate> },
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

  const output = workflow.build({
    input: createWorkflowInputRef<Input>(),
    run,
    validate,
    repeat,
  });

  return {
    workflow,
    plan: {
      workflow: { id: workflow.id },
      nodes,
      output: serializeBinding(output),
    },
    taskDefinitions,
    validatorDefinitions,
  };
}

export function buildPlan<Input, Output>(
  workflow: WorkflowDefinition<Input, Output>,
): Plan {
  return buildWorkflow(workflow).plan;
}

export function definePlan(plan: Plan): Plan {
  return plan;
}
