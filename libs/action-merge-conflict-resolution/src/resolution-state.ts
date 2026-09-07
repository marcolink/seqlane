import type {
  ConflictSet,
  ResolutionErrorDetails,
  ResolutionStrategy,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";

export type ResolutionAttemptPhase =
  | "ready"
  | "integrating"
  | "conflicted"
  | "preparing"
  | "resolving"
  | "validating"
  | "continuing"
  | "completed"
  | "failed";

export interface ResolutionState {
  readonly phase: ResolutionAttemptPhase;
  readonly strategy: ResolutionStrategy;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly conflicts: ConflictSet;
  readonly outcome?: "no-change" | "updated";
  readonly failure?: ResolutionErrorDetails;
}

export type ResolutionEvent =
  | { readonly type: "integration-started" }
  | { readonly type: "integration-clean" }
  | { readonly type: "integration-conflicted"; readonly conflicts: ConflictSet }
  | { readonly type: "attempt-started" }
  | { readonly type: "agent-prepared" }
  | { readonly type: "resolution-completed" }
  | { readonly type: "validation-passed" }
  | { readonly type: "continued"; readonly conflicts: ConflictSet }
  | { readonly type: "empty-commit-skipped" }
  | { readonly type: "completed"; readonly outcome: "no-change" | "updated" }
  | {
      readonly type: "failed";
      readonly error: Pick<ActionResolutionError, "category" | "code">;
    };

export function initialResolutionState(
  strategy: ResolutionStrategy,
  maxAttempts: number,
): ResolutionState {
  return {
    phase: "ready",
    strategy,
    attempts: 0,
    maxAttempts,
    conflicts: [],
  };
}

function invalidTransition(
  state: ResolutionState,
  event: ResolutionEvent,
): never {
  throw new ActionResolutionError(
    "operational",
    "OPERATION_FAILED",
    `Cannot apply ${event.type} while resolution is ${state.phase}.`,
  );
}

export function transitionResolutionState(
  state: ResolutionState,
  event: ResolutionEvent,
): ResolutionState {
  switch (event.type) {
    case "integration-started":
      if (state.phase !== "ready") return invalidTransition(state, event);
      return { ...state, phase: "integrating" };
    case "integration-clean":
      if (state.phase !== "integrating") return invalidTransition(state, event);
      return { ...state, phase: "completed", outcome: "no-change" };
    case "integration-conflicted":
      if (state.phase !== "integrating") return invalidTransition(state, event);
      return { ...state, phase: "conflicted", conflicts: event.conflicts };
    case "attempt-started":
      if (state.phase !== "conflicted") {
        return invalidTransition(state, event);
      }
      if (state.attempts >= state.maxAttempts) {
        return {
          ...state,
          phase: "failed",
          failure: {
            category: "attempt-limit",
            code: "ATTEMPT_LIMIT_EXCEEDED",
          },
        };
      }
      return { ...state, phase: "preparing", attempts: state.attempts + 1 };
    case "agent-prepared":
      if (state.phase !== "preparing") return invalidTransition(state, event);
      return { ...state, phase: "resolving" };
    case "resolution-completed":
      if (state.phase !== "resolving") return invalidTransition(state, event);
      return { ...state, phase: "validating" };
    case "validation-passed":
      if (state.phase !== "validating") return invalidTransition(state, event);
      return { ...state, phase: "continuing" };
    case "continued":
      if (state.phase !== "continuing") return invalidTransition(state, event);
      return { ...state, phase: "conflicted", conflicts: event.conflicts };
    case "empty-commit-skipped":
      if (state.phase !== "continuing") return invalidTransition(state, event);
      return { ...state, phase: "conflicted", conflicts: [] };
    case "completed":
      if (state.phase !== "continuing" && state.phase !== "conflicted") {
        return invalidTransition(state, event);
      }
      return { ...state, phase: "completed", outcome: event.outcome };
    case "failed":
      if (state.phase === "completed" || state.phase === "failed") {
        return invalidTransition(state, event);
      }
      return {
        ...state,
        phase: "failed",
        failure: event.error,
      };
  }
}

export function isTerminalResolutionState(state: ResolutionState): boolean {
  return state.phase === "completed" || state.phase === "failed";
}
