import { Effect } from "effect";
import {
  InputValidationError,
  OutputValidationError,
  RuntimeError,
} from "@seqlane/core";
import type { SeqlaneError } from "@seqlane/core";
import { resolveBinding } from "../runtime/plan/binding-resolution.js";
import { executeTask } from "../runtime/local/task-execution.js";
import { LocalProcessCancelledError } from "../runtime/local/effect-process.js";
import { toSeqlaneDisplayValue } from "../runtime/execution/display-value.js";
import { summarizeSeqlaneOutput } from "../runtime/execution/output-summary.js";
import { toSeqlaneInvocationError } from "../runtime/execution/errors.js";
import type { RunnerRunProgram, RunnerRunProgramResult } from "./run.js";

/**
 * S1-only deterministic Plan tracer. This composition is removed when the
 * production runner switches to the common Effect program in S9.
 */
export function createEffectTracerRunProgram(): RunnerRunProgram {
  return (context) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { workflow, request, events, signal, workId, runId } = context;
          const plan = workflow.plan;
          const taskNode = plan.nodes[0];
          const fail = (
            error: SeqlaneError,
            failedInvocationId?: string,
          ): RunnerRunProgramResult => {
            if (failedInvocationId !== undefined) {
              events.emit({
                type: "invocation.failed",
                workId,
                runId,
                invocationId: failedInvocationId,
                error,
                disposition: "fail_run",
              });
            }
            return failed(error);
          };

          if (plan.nodes.length !== 1 || taskNode?.type !== "task") {
            return failed(
              new RuntimeError(
                new Error("S1 Effect tracer supports one task Plan node"),
              ),
            );
          }

          const parsedWorkflowInput = yield* parseWithEffect(() =>
            workflow.workflow.input.parse(request.input),
          );
          if (parsedWorkflowInput._tag === "Failure") {
            return failed(
              new InputValidationError(
                workflow.workflow.id,
                parsedWorkflowInput.failure,
              ),
            );
          }
          const workflowInput = parsedWorkflowInput.success;

          const invocationId = context.createInvocationId(taskNode.nodeId);
          events.emit({
            type: "invocation.created",
            workId,
            runId,
            invocationId,
            planNodeId: taskNode.nodeId,
            subject: { type: "task", taskId: taskNode.taskId },
            taskId: taskNode.taskId,
            kind: "task",
            label: taskNode.taskId,
            siblingOrder: 0,
            dependencyIds: [],
          });

          if (signal.aborted) {
            events.emit({
              type: "invocation.cancelled",
              workId,
              runId,
              invocationId,
              reason: "Run cancelled before task execution",
            });
            return { status: "cancelled" } as const;
          }

          const taskDefinition = workflow.taskDefinitions.get(taskNode.taskId);
          if (taskDefinition === undefined) {
            return fail(
              toSeqlaneInvocationError(
                new Error(
                  `No task definition registered for "${taskNode.taskId}"`,
                ),
                "executor",
                taskNode.taskId,
              ),
              invocationId,
            );
          }

          const parsedTaskInput = yield* parseWithEffect(() =>
            taskDefinition.input.parse(
              resolveBinding(taskNode.input, workflowInput, new Map()),
            ),
          );
          if (parsedTaskInput._tag === "Failure") {
            return fail(
              toSeqlaneInvocationError(
                parsedTaskInput.failure,
                "input",
                taskNode.taskId,
              ),
              invocationId,
            );
          }
          const taskInput = parsedTaskInput.success;

          events.emit({
            type: "invocation.started",
            workId,
            runId,
            invocationId,
            subject: { type: "task", taskId: taskNode.taskId },
            taskId: taskNode.taskId,
          });
          events.emit({
            type: "invocation.output",
            workId,
            runId,
            invocationId,
            policy: "transient",
            channel: "task",
            content: "Executing task",
          });

          events.emit({
            type: "invocation.input",
            workId,
            runId,
            invocationId,
            input: toSeqlaneDisplayValue(taskInput),
          });

          let uncertainTermination = false;
          const taskExecution = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                executeTask({
                  definition: taskDefinition,
                  input: taskInput,
                  cwd: process.cwd(),
                  taskId: taskNode.taskId,
                  invocationId,
                  signal,
                  runAgent: async () => {
                    throw new Error(
                      "The S1 Effect tracer does not execute agent tasks",
                    );
                  },
                  onUncertainActivity: () => {
                    uncertainTermination = true;
                  },
                }),
              catch: (cause) => cause,
            }),
          );
          if (taskExecution._tag === "Failure") {
            const cause = taskExecution.failure;
            if (uncertainTermination) {
              return fail(new RuntimeError(cause), invocationId);
            }
            if (signal.aborted && cause instanceof LocalProcessCancelledError) {
              events.emit({
                type: "invocation.cancelled",
                workId,
                runId,
                invocationId,
                reason: "Run cancelled after process termination",
              });
              return { status: "cancelled" } as const;
            }
            return fail(
              toSeqlaneInvocationError(cause, "executor", taskNode.taskId),
              invocationId,
            );
          }
          const rawOutput = taskExecution.success;

          const parsedTaskOutput = yield* parseWithEffect(() =>
            taskDefinition.output.parse(rawOutput),
          );
          if (parsedTaskOutput._tag === "Failure") {
            return fail(
              toSeqlaneInvocationError(
                parsedTaskOutput.failure,
                "output",
                taskNode.taskId,
              ),
              invocationId,
            );
          }
          const taskOutput = parsedTaskOutput.success;

          events.emit({
            type: "invocation.result",
            workId,
            runId,
            invocationId,
            result: toSeqlaneDisplayValue(taskOutput),
          });
          events.emit({
            type: "invocation.succeeded",
            workId,
            runId,
            invocationId,
          });
          events.emit({
            type: "invocation.output",
            workId,
            runId,
            invocationId,
            policy: "persistent",
            channel: "task",
            content: "Task completed",
            summary: summarizeSeqlaneOutput(taskOutput),
          });
          const parsedWorkflowOutput = yield* parseWithEffect(() =>
            workflow.workflow.output.parse(
              resolveBinding(
                plan.output,
                workflowInput,
                new Map([[taskNode.nodeId, taskOutput]]),
              ),
            ),
          );
          if (parsedWorkflowOutput._tag === "Failure") {
            return failed(
              new OutputValidationError(
                workflow.workflow.id,
                parsedWorkflowOutput.failure,
              ),
            );
          }
          const output = parsedWorkflowOutput.success;
          return { status: "succeeded", output } as const;
        }),
      ),
    );
}

function failed(error: SeqlaneError): RunnerRunProgramResult {
  return { status: "failed", error };
}

function parseWithEffect<T>(parse: () => T) {
  return Effect.result(
    Effect.try({
      try: parse,
      catch: (cause) => cause,
    }),
  );
}
