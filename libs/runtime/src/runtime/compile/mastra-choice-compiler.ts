import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { AnyWorkflow, Step } from "@mastra/core/workflows";
import type {
  ChoiceNode,
  InvocationId,
  PlanNode,
  SeqlaneError,
  SeqlaneSchema,
} from "@seqlane/core";
import { z } from "zod";
import { resolveBinding } from "../plan/binding-resolution.js";
import { toSeqlaneDisplayValue } from "../execution/display-value.js";
import type { SeqlaneFailurePhase } from "../execution/errors.js";
import { resolveMastraPlanRunContext } from "./mastra-run-context.js";
import type { MastraPlanCompilerOptions } from "./mastra-plan-compiler.js";

type Arm = ChoiceNode["then"];

const choiceEnvelopeSchema = z.strictObject({
  condition: z.boolean(),
  workflowInput: z.unknown(),
  results: z.record(z.string(), z.unknown()),
  workId: z.string(),
  runId: z.string(),
  resourceId: z.string().optional(),
});

type ChoiceEnvelope = z.infer<typeof choiceEnvelopeSchema>;

export interface ChoiceCompilerDependencies {
  readonly schemaForNodeInput: (
    node: PlanNode,
    options: MastraPlanCompilerOptions,
  ) => SeqlaneSchema | undefined;
  readonly reportFailure: (
    node: PlanNode,
    cause: unknown,
    phase: SeqlaneFailurePhase,
    options: MastraPlanCompilerOptions,
  ) => SeqlaneError;
  readonly invocationIdForNode: (nodeId: string) => InvocationId | undefined;
}

function armStep(
  arm: Arm,
  validation: NonNullable<ChoiceNode["validation"]>["then"],
  options: MastraPlanCompilerOptions,
  dependencies: ChoiceCompilerDependencies,
  failures: Map<string, unknown>,
) {
  return createStep({
    id: arm.nodeId,
    description: `Execute Seqlane choice arm ${arm.nodeId}`,
    inputSchema: choiceEnvelopeSchema,
    // The ordinary invocation handler already validates the selected output.
    outputSchema: z.unknown(),
    execute: async ({
      inputData,
      requestContext,
      abortSignal,
      tracing,
      tracingContext,
      loggerVNext,
      metrics,
    }) => {
      const envelope = choiceEnvelopeSchema.parse(inputData);
      try {
        const results = new Map(Object.entries(envelope.results));
        const rawInput = resolveBinding(
          arm.input,
          envelope.workflowInput,
          results,
        );
        let input: unknown;
        try {
          input =
            dependencies.schemaForNodeInput(arm, options)?.parse(rawInput) ??
            rawInput;
        } catch (cause) {
          const error = dependencies.reportFailure(
            arm,
            cause,
            "input",
            options,
          );
          const invocationId = dependencies.invocationIdForNode(arm.nodeId);
          if (invocationId !== undefined) {
            options.onInputValidationFailure?.({
              node: arm,
              workId: envelope.workId,
              runId: envelope.runId,
              invocationId,
              error,
            });
          }
          throw error;
        }
        const invoke =
          arm.type === "workflow"
            ? options.executeWorkflowInvocation
            : options.executeInvocation;
        const invocationId = dependencies.invocationIdForNode(arm.nodeId);
        if (invoke === undefined || invocationId === undefined) {
          throw new Error(
            `No invocation handler or identity for choice arm "${arm.nodeId}"`,
          );
        }
        return await invoke({
          node: arm,
          input,
          workflowInput: envelope.workflowInput,
          workId: envelope.workId,
          runId: envelope.runId,
          invocationId,
          ...(envelope.resourceId === undefined
            ? {}
            : { resourceId: envelope.resourceId }),
          workflowId: options.workflowId ?? arm.nodeId,
          dynamicWorkspaceAdmission: true,
          ...(validation === undefined ? {} : { choiceValidation: validation }),
          abortSignal,
          requestContext,
          observability: { tracing, tracingContext, loggerVNext, metrics },
          // Mastra's callback is generic; this value has the original
          // validated Plan step result type at this private integration seam.
          getStepResult: <Output = unknown>(nodeId: string) =>
            results.get(nodeId) as Output,
        });
      } catch (cause) {
        failures.set(envelope.runId, cause);
        throw cause;
      }
    },
  });
}

function branchWorkflow(
  node: ChoiceNode,
  options: MastraPlanCompilerOptions,
  dependencies: ChoiceCompilerDependencies,
  failures: Map<string, unknown>,
): AnyWorkflow {
  const identity = createStep({
    id: `${node.nodeId}:condition`,
    inputSchema: choiceEnvelopeSchema,
    outputSchema: choiceEnvelopeSchema,
    execute: async ({ inputData }) => choiceEnvelopeSchema.parse(inputData),
  });
  const thenStep = armStep(
    node.then,
    node.validation?.then,
    options,
    dependencies,
    failures,
  );
  const elseStep = armStep(
    node.else,
    node.validation?.else,
    options,
    dependencies,
    failures,
  );
  const join = createStep({
    id: `${node.nodeId}:result`,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    execute: async ({ inputData, getInitData }) => {
      const envelope = choiceEnvelopeSchema.parse(getInitData<unknown>());
      const selectedId = envelope.condition
        ? node.then.nodeId
        : node.else.nodeId;
      const branchResults = z.record(z.string(), z.unknown()).parse(inputData);
      if (!Object.hasOwn(branchResults, selectedId)) {
        throw new Error(`Choice "${node.nodeId}" has no selected result`);
      }
      return branchResults[selectedId];
    },
  });
  return (
    createWorkflow({
      id: `${node.nodeId}:branch`,
      inputSchema: choiceEnvelopeSchema,
      outputSchema: z.unknown(),
    }) as AnyWorkflow
  )
    .then(identity)
    .branch([
      [
        async ({ inputData }) =>
          choiceEnvelopeSchema.parse(inputData).condition,
        thenStep,
      ],
      [
        async ({ inputData }) =>
          !choiceEnvelopeSchema.parse(inputData).condition,
        elseStep,
      ],
    ])
    .then(join)
    .commit() as AnyWorkflow;
}

function outerResults(
  node: ChoiceNode,
  getStepResult: <Output = unknown>(nodeId: string) => Output,
): Record<string, unknown> {
  return Object.fromEntries(
    node.dependsOn.map((dependency) => [dependency, getStepResult(dependency)]),
  );
}

export function buildChoiceStep(
  node: ChoiceNode,
  options: MastraPlanCompilerOptions,
  invocationId: InvocationId,
  dependencies: ChoiceCompilerDependencies,
): Step {
  const failures = new Map<string, unknown>();
  const branch = branchWorkflow(node, options, dependencies, failures);
  return createStep({
    id: node.nodeId,
    description: `Execute Seqlane choice ${node.nodeId}`,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    execute: async ({
      getInitData,
      getStepResult,
      runId,
      resourceId,
      requestContext,
      abortSignal,
      tracing,
      tracingContext,
      loggerVNext,
      metrics,
      mastra,
    }) => {
      const runContext = resolveMastraPlanRunContext({
        runId,
        resourceId,
        requestContext,
        mastra,
        workId: options.workId,
        events: options.events,
        repeatBudget: options.repeatBudget,
      });
      const subject = { type: "choice" as const, planNodeId: node.nodeId };
      runContext.events.emit({
        type: "invocation.started",
        workId: runContext.workId,
        runId: runContext.runId,
        invocationId,
        subject,
      });
      let run: Awaited<ReturnType<typeof branch.createRun>> | undefined;
      const cancel = (): void => {
        if (run !== undefined) void run.cancel().catch(() => undefined);
      };
      if (abortSignal.aborted) cancel();
      else abortSignal.addEventListener("abort", cancel, { once: true });
      try {
        const workflowInput = getInitData<unknown>();
        const results = outerResults(node, getStepResult);
        const condition = resolveBinding(
          node.condition,
          workflowInput,
          new Map(Object.entries(results)),
        );
        if (typeof condition !== "boolean") {
          for (const arm of [node.then, node.else]) {
            const armId = dependencies.invocationIdForNode(arm.nodeId);
            if (armId !== undefined) {
              runContext.events.emit({
                type: "invocation.skipped",
                workId: runContext.workId,
                runId: runContext.runId,
                invocationId: armId,
                reason: "Choice condition is not Boolean",
                dependencyIds: [invocationId],
              });
            }
          }
          throw dependencies.reportFailure(
            node,
            new TypeError(`Choice "${node.nodeId}" condition must be Boolean`),
            "input",
            options,
          );
        }
        const skipped = condition ? node.else : node.then;
        const skippedId = dependencies.invocationIdForNode(skipped.nodeId);
        if (skippedId !== undefined) {
          runContext.events.emit({
            type: "invocation.skipped",
            workId: runContext.workId,
            runId: runContext.runId,
            invocationId: skippedId,
            reason: "Choice arm not selected",
            dependencyIds: [invocationId],
          });
        }
        const envelope: ChoiceEnvelope = {
          condition,
          workflowInput,
          results,
          workId: runContext.workId,
          runId: runContext.runId,
          ...(runContext.resourceId === undefined
            ? {}
            : { resourceId: runContext.resourceId }),
        };
        if (runContext.mastra !== undefined) {
          branch.__registerMastra(runContext.mastra);
        }
        run = await branch.createRun({
          runId: `${runContext.runId}:${node.nodeId}`,
          resourceId: runContext.resourceId,
        });
        if (abortSignal.aborted) cancel();
        const result = await run.start({
          inputData: envelope,
          requestContext: runContext.requestContext,
          ...(tracing === undefined ? {} : { tracing }),
          ...(tracingContext === undefined ? {} : { tracingContext }),
          ...(loggerVNext === undefined ? {} : { loggerVNext }),
          ...(metrics === undefined ? {} : { metrics }),
        });
        if (result.status !== "success") {
          if (abortSignal.aborted) {
            throw abortSignal.reason ?? new Error("Choice cancelled");
          }
          throw (
            failures.get(runContext.runId) ??
            new Error(`Choice "${node.nodeId}" failed`)
          );
        }
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
        return result.result;
      } catch (cause) {
        if (abortSignal.aborted) {
          runContext.events.emit({
            type: "invocation.cancelled",
            workId: runContext.workId,
            runId: runContext.runId,
            invocationId,
            reason: "Choice cancelled",
          });
          throw cause;
        }
        const error = dependencies.reportFailure(
          node,
          cause,
          "runtime",
          options,
        );
        runContext.events.emit({
          type: "invocation.failed",
          workId: runContext.workId,
          runId: runContext.runId,
          invocationId,
          error,
          disposition: "fail_run",
        });
        throw error;
      } finally {
        failures.delete(runContext.runId);
        abortSignal.removeEventListener("abort", cancel);
      }
    },
  });
}
