export interface SequentialProgramStep {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly execute: (options: {
    readonly abortSignal: AbortSignal;
  }) => Promise<unknown>;
}

export interface SequentialProgram {
  readonly steps: readonly SequentialProgramStep[];
}

export type SequentialProgramResult =
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "success" };

export function createSequentialProgram(options: {
  readonly steps: readonly SequentialProgramStep[];
}): SequentialProgram {
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
  return Object.freeze({
    steps: Object.freeze(steps),
  });
}

async function executeDependencyProgram(
  program: SequentialProgram,
  abortSignal: AbortSignal,
): Promise<void> {
  const stepsById = new Map(program.steps.map((step) => [step.id, step]));
  const executing = new Map<string, Promise<unknown>>();
  const executeStep = (step: SequentialProgramStep): Promise<unknown> => {
    const current = executing.get(step.id);
    if (current !== undefined) return current;
    const dependencies = (step.dependsOn ?? []).map((dependencyId) => {
      const dependency = stepsById.get(dependencyId);
      if (dependency === undefined) {
        throw new Error(
          `Sequential program step "${step.id}" depends on unknown step "${dependencyId}"`,
        );
      }
      return executeStep(dependency);
    });
    const execution = Promise.all(dependencies).then(async () => {
      if (abortSignal.aborted) throw new Error("Program execution cancelled");
      return step.execute({ abortSignal });
    });
    executing.set(step.id, execution);
    return execution;
  };

  const outcomes = await Promise.allSettled(
    program.steps.map((step) => executeStep(step)),
  );
  const failed = outcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  if (failed !== undefined) throw failed.reason;
}

export function executeSequentialProgram(
  program: SequentialProgram,
  signal?: AbortSignal,
): Promise<SequentialProgramResult> {
  if (signal?.aborted) return Promise.resolve({ status: "cancelled" });

  // Keep waiting for active executor work to settle after cancellation. This
  // preserves the subprocess/session cleanup guarantee without a second
  // orchestration runtime.
  const abortSignal = signal ?? new AbortController().signal;
  return executeDependencyProgram(program, abortSignal).then(
    () =>
      abortSignal.aborted ? { status: "cancelled" } : { status: "success" },
    (error) =>
      abortSignal.aborted
        ? { status: "cancelled" }
        : { status: "failed", error },
  );
}
