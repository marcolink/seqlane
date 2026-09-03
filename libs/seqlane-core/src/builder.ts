import { taskDefinitionSchema } from "./contracts.js";
import type {
  AgentTaskDefinition,
  AgentTaskInvocationOptions,
  LocalTaskDefinition,
  LocalTaskInvocationOptions,
  TaskDefinition,
  TaskId,
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
  policy: AgentTaskInvocationOptions<unknown, unknown>["session"],
): PlanSessionPolicy {
  const resolved = policy ?? isolated();
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

export function buildWorkflow<Input, Output>(
  workflow: WorkflowDefinition<Input, Output>,
): BuiltWorkflow<Input, Output> {
  const nodes: PlanNode[] = [];
  const invocationCounts = new Map<TaskId, number>();
  const validationCounts = new Map<string, number>();
  let repeatCount = 0;
  const taskDefinitions = new Map<TaskId, TaskDefinition<unknown, unknown>>();
  const validatorDefinitions = new Map<string, ValidatorDefinition<unknown>>();

  function run<TaskInput, TaskOutput>(
    task: AgentTaskDefinition<TaskInput, TaskOutput>,
    options: AgentTaskInvocationOptions<TaskInput, TaskOutput>,
  ): TaskInvocation<TaskOutput>;
  function run<TaskInput, TaskOutput>(
    task: LocalTaskDefinition<TaskInput, TaskOutput>,
    options: LocalTaskInvocationOptions<TaskInput, TaskOutput>,
  ): MechanicalTaskRef<TaskOutput>;
  function run<TaskInput, TaskOutput>(
    task: TaskDefinition<TaskInput, TaskOutput>,
    options:
      | AgentTaskInvocationOptions<TaskInput, TaskOutput>
      | LocalTaskInvocationOptions<TaskInput, TaskOutput>,
  ): TaskInvocation<TaskOutput> | MechanicalTaskRef<TaskOutput> {
    taskDefinitionSchema.parse(task);
    const count = (invocationCounts.get(task.id) ?? 0) + 1;
    invocationCounts.set(task.id, count);
    const nodeId = `${task.id}:${count}`;
    const dependencies = new Set<string>();

    collectDependencies(options.input, dependencies);
    for (const dependency of options.dependsOn ?? []) {
      dependencies.add(dependency.nodeId);
    }
    const session = serializeSessionPolicy(
      "session" in options ? options.session : undefined,
    );
    if (session.type !== "isolated") dependencies.add(session.from);
    taskDefinitions.set(task.id, task);
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
      return "goal" in task
        ? {
            nodeId,
            output: validation.output,
            session: createSessionCheckpointRef(nodeId),
          }
        : { nodeId, output: validation.output };
    }

    return "goal" in task
      ? { nodeId, output, session: createSessionCheckpointRef(nodeId) }
      : { nodeId, output };
  }

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
    if ("goal" in validator) {
      taskDefinitions.set(validator.id, validator);
      source = {
        type: "task",
        taskId: validator.id,
        workspace: validator.workspace ?? "exclusive",
      };
    } else {
      const existing = validatorDefinitions.get(validator.id);
      if (existing !== undefined && existing !== validator) {
        throw new Error(`Duplicate validator definition "${validator.id}"`);
      }
      validatorDefinitions.set(validator.id, validator);
      source = { type: "mechanical", validatorId: validator.id };
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
    function bodyTask<TaskInput, TaskOutput>(
      task: AgentTaskDefinition<TaskInput, TaskOutput>,
      taskOptions: Omit<
        AgentTaskInvocationOptions<TaskInput, TaskOutput>,
        "validateOutput"
      >,
    ): TaskInvocation<TaskOutput>;
    function bodyTask<TaskInput, TaskOutput>(
      task: LocalTaskDefinition<TaskInput, TaskOutput>,
      taskOptions: Omit<
        LocalTaskInvocationOptions<TaskInput, TaskOutput>,
        "validateOutput"
      >,
    ): MechanicalTaskRef<TaskOutput>;
    function bodyTask<TaskInput, TaskOutput>(
      task: TaskDefinition<TaskInput, TaskOutput>,
      taskOptions:
        | Omit<
            AgentTaskInvocationOptions<TaskInput, TaskOutput>,
            "validateOutput"
          >
        | Omit<
            LocalTaskInvocationOptions<TaskInput, TaskOutput>,
            "validateOutput"
          >,
    ): TaskInvocation<TaskOutput> | MechanicalTaskRef<TaskOutput> {
      taskDefinitionSchema.parse(task);
      const count = (bodyCounts.get(task.id) ?? 0) + 1;
      bodyCounts.set(task.id, count);
      const bodyNodeId = `${nodeId}/${task.id}:${count}`;
      const bodyDependencies = new Set<string>();
      collectDependencies(taskOptions.input, bodyDependencies);
      for (const dependency of taskOptions.dependsOn ?? []) {
        bodyDependencies.add(dependency.nodeId);
      }
      const session = serializeSessionPolicy(
        "session" in taskOptions ? taskOptions.session : undefined,
      );
      if (session.type !== "isolated") bodyDependencies.add(session.from);
      taskDefinitions.set(task.id, task);
      bodyNodes.push({
        type: "task",
        taskId: task.id,
        nodeId: bodyNodeId,
        workspace: task.workspace ?? "exclusive",
        session,
        input: serializeBinding(taskOptions.input),
        dependsOn: [...bodyDependencies],
      });
      const output = createValueRef<TaskOutput>(bodyNodeId, ["output"]);
      return "goal" in task
        ? {
            nodeId: bodyNodeId,
            output,
            session: createSessionCheckpointRef(bodyNodeId),
          }
        : { nodeId: bodyNodeId, output };
    }
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
