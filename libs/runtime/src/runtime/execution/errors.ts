import {
  ExecutorError,
  InteractionRequiredError,
  InputValidationError,
  OutputValidationError,
  RuntimeError,
  SeqlaneError,
  type TaskId,
} from "@seqlane/core";

export type SeqlaneFailurePhase = "input" | "executor" | "output" | "runtime";

export function toSeqlaneInvocationError(
  cause: unknown,
  phase: SeqlaneFailurePhase,
  taskId: TaskId,
): SeqlaneError {
  if (phase === "executor" && cause instanceof InteractionRequiredError) {
    return new ExecutorError(taskId, cause);
  }

  if (cause instanceof SeqlaneError) return cause;

  switch (phase) {
    case "input":
      return new InputValidationError(taskId, cause);
    case "executor":
      return new ExecutorError(taskId, cause);
    case "output":
      return new OutputValidationError(taskId, cause);
    case "runtime":
      return new RuntimeError(cause);
  }
}
