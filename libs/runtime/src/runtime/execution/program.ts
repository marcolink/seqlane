import { Effect } from "effect";
import type * as Semaphore from "effect/Semaphore";
import { z } from "zod";
import { runSequentialGraph } from "./run-sequential-graph.js";

export interface SequentialProgramStep {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly execute: (options: {
    readonly abortSignal: AbortSignal;
  }) => Promise<unknown>;
  /** Target path that can wait for admission before taking a body permit. */
  readonly executeEffect?: (options: {
    readonly abortSignal: AbortSignal;
    readonly withBodyPermit: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E>;
  }) => Effect.Effect<unknown, unknown>;
  readonly onSkip?: (failedDependencyIds: readonly string[]) => void;
  readonly onCancel?: () => void;
}

export type SequentialProgramStepResult =
  | { readonly status: "success"; readonly value: unknown }
  | { readonly status: "failed"; readonly error: unknown };

export interface SequentialProgram {
  readonly steps: readonly (SequentialProgramStep & {
    readonly dependsOn: readonly string[];
  })[];
  /** Native graph effect. Promise facades evaluate this only at the boundary. */
  readonly effect: (
    abortSignal: AbortSignal,
    bodySemaphore?: Semaphore.Semaphore,
  ) => Effect.Effect<readonly SequentialProgramStepResult[]>;
}

export type SequentialProgramResult =
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "success" };

const programOptionsSchema = z
  .object({ concurrency: z.number().int().positive().safe().optional() })
  .strict();

export function createSequentialProgram(options: {
  readonly steps: readonly SequentialProgramStep[];
  /** Private body concurrency bound. Dependency waits do not hold permits. */
  readonly concurrency?: number;
}): SequentialProgram {
  programOptionsSchema.parse({ concurrency: options.concurrency });
  const stepIds = new Set<string>();
  const steps = options.steps.map((step, index) => {
    if (stepIds.has(step.id)) {
      throw new Error(
        `Sequential program contains duplicate step "${step.id}"`,
      );
    }
    stepIds.add(step.id);
    const previousStep = options.steps[index - 1];
    return Object.freeze({
      ...step,
      dependsOn: Object.freeze(
        step.dependsOn === undefined
          ? previousStep === undefined
            ? []
            : [previousStep.id]
          : [...step.dependsOn],
      ),
    });
  });
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    for (const dependencyId of step.dependsOn) {
      if (!stepsById.has(dependencyId)) {
        throw new Error(
          `Sequential program step "${step.id}" depends on unknown step "${dependencyId}"`,
        );
      }
    }
  }
  assertAcyclic(steps);
  const concurrency = options.concurrency ?? Number.POSITIVE_INFINITY;

  const effect = (
    abortSignal: AbortSignal,
    bodySemaphore?: Semaphore.Semaphore,
  ) => runSequentialGraph(steps, concurrency, abortSignal, bodySemaphore);

  return Object.freeze({ steps: Object.freeze(steps), effect });
}

function assertAcyclic(
  steps: readonly (SequentialProgramStep & {
    readonly dependsOn: readonly string[];
  })[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(
        `Sequential program contains a dependency cycle at "${id}"`,
      );
    }
    visiting.add(id);
    const step = byId.get(id);
    if (step === undefined) {
      throw new Error(`Sequential program step "${id}" is not defined`);
    }
    for (const dependencyId of step.dependsOn) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
}

export function executeSequentialProgram(
  program: SequentialProgram,
  signal?: AbortSignal,
): Promise<SequentialProgramResult> {
  if (signal?.aborted) return Promise.resolve({ status: "cancelled" });
  const abortSignal = signal ?? new AbortController().signal;
  return Effect.runPromise(runProgram(program, abortSignal)).then((results) => {
    if (abortSignal.aborted) return { status: "cancelled" } as const;
    const failed = results.find((result) => result.status === "failed");
    return failed === undefined
      ? ({ status: "success" } as const)
      : ({ status: "failed", error: failed.error } as const);
  });
}

/** Evaluate the graph inside a larger Effect program without a nested runtime. */
export function runProgram(
  program: SequentialProgram,
  abortSignal: AbortSignal,
  bodySemaphore?: Semaphore.Semaphore,
): Effect.Effect<readonly SequentialProgramStepResult[]> {
  return program.effect(abortSignal, bodySemaphore);
}
