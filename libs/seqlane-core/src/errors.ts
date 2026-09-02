import type {
  InteractionRequirement,
  JsonValue,
  PlanNodeId,
  TaskId,
  ValidationIssue,
} from "./contracts.js";

export type SeqlaneErrorCategory =
  | "InputValidationError"
  | "ExecutorError"
  | "OutputValidationError"
  | "ValidationError"
  | "RuntimeError";

export class InteractionRequiredError extends Error {
  constructor(readonly requirement: InteractionRequirement) {
    super("Seqlane execution requires human interaction");
    this.name = "InteractionRequiredError";
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class SeqlaneError extends Error {
  constructor(
    readonly category: SeqlaneErrorCategory,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = category;
  }
}

export class InputValidationError extends SeqlaneError {
  constructor(
    readonly taskId: TaskId,
    cause: unknown,
  ) {
    super(
      "InputValidationError",
      `Task input validation failed for "${taskId}": ${describeCause(cause)}`,
      cause,
    );
  }
}

export class ExecutorError extends SeqlaneError {
  constructor(
    readonly taskId: TaskId,
    cause: unknown,
  ) {
    super(
      "ExecutorError",
      `Task executor failed for "${taskId}": ${describeCause(cause)}`,
      cause,
    );
  }
}

export class OutputValidationError extends SeqlaneError {
  constructor(
    readonly taskId: TaskId,
    cause: unknown,
  ) {
    super(
      "OutputValidationError",
      `Task output validation failed for "${taskId}": ${describeCause(cause)}`,
      cause,
    );
  }
}

export class ValidationFailedError extends SeqlaneError {
  constructor(
    readonly nodeId: PlanNodeId,
    readonly sourceId: string,
    readonly issues: readonly ValidationIssue[],
    readonly evidence?: JsonValue,
  ) {
    super(
      "ValidationError",
      `Validation failed for "${nodeId}" from "${sourceId}": ${issues
        .map(({ message }) => message)
        .join("; ")}`,
    );
  }
}

export class RuntimeError extends SeqlaneError {
  constructor(cause: unknown) {
    super(
      "RuntimeError",
      `Seqlane runtime failed: ${describeCause(cause)}`,
      cause,
    );
  }
}

export class LoopLimitExceededError extends SeqlaneError {
  constructor(
    readonly nodeId: PlanNodeId,
    readonly maximumIterations: number,
    readonly issues?: readonly ValidationIssue[],
    readonly evidence?: JsonValue,
  ) {
    super(
      "RuntimeError",
      `Repeat "${nodeId}" exceeded its maximum of ${maximumIterations} iterations`,
    );
  }
}
