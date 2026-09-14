import type { AnyWorkflow } from "@mastra/core/workflows";
import type { ObservabilityContext } from "@mastra/core/observability";
import { SeqlaneError } from "@seqlane/core";
import type { InvocationId, PlanNode } from "@seqlane/core";
import { summarizeSeqlaneOutput } from "../execution/output-summary.js";
import { toSeqlaneDisplayValue } from "../execution/display-value.js";
import { taskIdCompatibility } from "../invocation/invocation-support.js";
import {
  invocationKind as planInvocationKind,
  invocationTaskId as planInvocationTaskId,
  invocationSubject as planInvocationSubject,
} from "../execution/workflow-run.js";
import type { MastraPlanCompilerOptions } from "./mastra-plan-compiler.js";
import type { RepeatEnvelope } from "./mastra-repeat-envelope.js";
import type { RepeatCompilerDependencies } from "./mastra-repeat-compiler.js";
import type { MastraPlanRunContext } from "./mastra-run-context.js";

function emitRepeatFailure(
  cause: unknown,
  node: Extract<PlanNode, { type: "repeat" }>,
  options: MastraPlanCompilerOptions,
  dependencies: RepeatCompilerDependencies,
  runContext: MastraPlanRunContext,
  invocationId: InvocationId,
): SeqlaneError {
  const error =
    cause instanceof SeqlaneError
      ? cause
      : dependencies.reportFailure(node, cause, "runtime", options);
  runContext.events.emit({
    type: "invocation.failed",
    workId: runContext.workId,
    runId: runContext.runId,
    invocationId,
    error,
    disposition: "fail_run",
  });
  return error;
}

export async function runRepeatWorkflow(options: {
  readonly node: Extract<PlanNode, { type: "repeat" }>;
  readonly loop: AnyWorkflow;
  readonly envelope: RepeatEnvelope;
  readonly runContext: MastraPlanRunContext;
  readonly compilerOptions: MastraPlanCompilerOptions;
  readonly dependencies: RepeatCompilerDependencies;
  readonly invocationId: InvocationId;
  readonly abortSignal: AbortSignal;
  readonly observability: Partial<ObservabilityContext>;
  readonly emitCreated: boolean;
}): Promise<unknown> {
  const {
    node,
    loop,
    envelope,
    runContext,
    compilerOptions,
    dependencies,
    invocationId,
    abortSignal,
    observability,
  } = options;
  const subject = planInvocationSubject(node);
  if (options.emitCreated) {
    const dependencyIds = node.dependsOn.flatMap((dependency) => {
      const dependencyId = dependencies.invocationIdForNode(dependency);
      return dependencyId === undefined ? [] : [dependencyId];
    });
    runContext.events.emit({
      type: "invocation.created",
      workId: runContext.workId,
      runId: runContext.runId,
      invocationId,
      planNodeId: node.nodeId,
      subject,
      ...taskIdCompatibility(subject),
      kind: planInvocationKind(node),
      label: planInvocationTaskId(node),
      siblingOrder: dependencies.siblingOrderForNode?.(node.nodeId) ?? 0,
      dependencyIds,
    });
  }
  runContext.events.emit({
    type: "invocation.started",
    workId: runContext.workId,
    runId: runContext.runId,
    invocationId,
    subject,
    ...taskIdCompatibility(subject),
  });
  runContext.events.emit({
    type: "invocation.progress",
    workId: runContext.workId,
    runId: runContext.runId,
    invocationId,
    state: "active",
    phase: "execute",
    message: "Executing repeat",
  });
  runContext.events.emit({
    type: "invocation.output",
    workId: runContext.workId,
    runId: runContext.runId,
    invocationId,
    policy: "transient",
    channel: "task",
    content: "Executing repeat",
  });
  let run: Awaited<ReturnType<typeof loop.createRun>> | undefined;
  const cancel = (): void => {
    if (run !== undefined) void run.cancel().catch(() => undefined);
  };
  if (abortSignal.aborted) cancel();
  else abortSignal.addEventListener("abort", cancel, { once: true });
  try {
    run = await loop.createRun({
      runId: `${runContext.runId}:${node.nodeId}`,
      resourceId: runContext.resourceId,
    });
    const result = await run.start({
      inputData: envelope,
      requestContext: runContext.requestContext,
      ...(observability.tracing === undefined
        ? {}
        : { tracing: observability.tracing }),
      ...(observability.tracingContext === undefined
        ? {}
        : { tracingContext: observability.tracingContext }),
      ...(observability.loggerVNext === undefined
        ? {}
        : { loggerVNext: observability.loggerVNext }),
      ...(observability.metrics === undefined
        ? {}
        : { metrics: observability.metrics }),
    });
    if (result.status === "success") {
      runContext.events.emit({
        type: "invocation.result",
        workId: runContext.workId,
        runId: runContext.runId,
        invocationId,
        result: toSeqlaneDisplayValue(result.result, undefined),
      });
      runContext.events.emit({
        type: "invocation.succeeded",
        workId: runContext.workId,
        runId: runContext.runId,
        invocationId,
      });
      runContext.events.emit({
        type: "invocation.output",
        workId: runContext.workId,
        runId: runContext.runId,
        invocationId,
        policy: "persistent",
        channel: "task",
        content: "Repeat completed",
        summary: summarizeSeqlaneOutput(result.result),
      });
      return result.result;
    }
    if (result.status === "failed" && "error" in result) {
      throw result.error;
    }
    throw abortSignal.reason ?? new Error(`Repeat "${node.nodeId}" failed`);
  } catch (cause) {
    if (abortSignal.aborted) {
      runContext.events.emit({
        type: "invocation.cancelled",
        workId: runContext.workId,
        runId: runContext.runId,
        invocationId,
        reason: "Repeat cancelled",
      });
      throw cause;
    }
    throw emitRepeatFailure(
      cause,
      node,
      compilerOptions,
      dependencies,
      runContext,
      invocationId,
    );
  } finally {
    abortSignal.removeEventListener("abort", cancel);
  }
}
