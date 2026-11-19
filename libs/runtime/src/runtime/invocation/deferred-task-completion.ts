import type { InvocationId, OutputValidation, TaskNode } from "@seqlane/core";
import { Effect } from "effect";
import type { ExecutionContext } from "../execution/context.js";
import { validateRunnableOutputEffect } from "../validation/output-validation-effect.js";
import {
  completeDeferredTaskNode,
  failDeferredTaskNode,
} from "./invocation-execution.js";
import { settleOwnedPromise } from "./task-admission.js";
import type { UnconfirmedInvocationTerminationError } from "../execution/executor.js";

/** Validates a paid task result, then publishes its single terminal success. */
export function completeValidatedTaskEffect(options: {
  readonly context: ExecutionContext;
  readonly node: TaskNode;
  readonly invocationId: InvocationId;
  readonly iteration?: number;
  readonly validation?: OutputValidation;
  readonly abortSignal: AbortSignal;
  readonly withBodyPermit: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
}): (
  output: unknown,
  onUnconfirmed: (error: UnconfirmedInvocationTerminationError) => void,
  cleanupTimeoutMs: number,
) => Effect.Effect<void, unknown> {
  return (output, onUnconfirmed, cleanupTimeoutMs) =>
    Effect.gen(function* () {
      const { context, node, invocationId, iteration, abortSignal } = options;
      yield* Effect.catch(
        validateRunnableOutputEffect(
          context,
          node,
          output,
          options.validation,
          abortSignal,
          {
            invocationId,
            ...(iteration === undefined ? {} : { iteration }),
            withBodyPermit: options.withBodyPermit,
          },
        ),
        (cause) =>
          Effect.try({
            try: () =>
              failDeferredTaskNode(cause, context, node, abortSignal, output, {
                invocationId,
                ...(iteration === undefined ? {} : { iteration }),
              }),
            catch: (failure) => failure,
          }),
      );
      yield* settleOwnedPromise(
        () =>
          completeDeferredTaskNode(context, node, output, {
            invocationId,
            results: context.results,
            remainingConsumers: context.remainingConsumers,
            ...(iteration === undefined ? {} : { iteration }),
          }),
        cleanupTimeoutMs,
        onUnconfirmed,
      );
    });
}
