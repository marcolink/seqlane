import { Effect } from "effect";
import { InputValidationError, type WorkflowNode } from "@seqlane/core";
import type { ExecutionContext } from "./context.js";
import type {
  EffectPlanRunContext,
  EffectPlanRunResult,
} from "./effect-plan.js";
import { invocationCreationOrdinal } from "./context.js";
import { toSeqlaneDisplayValue } from "./display-value.js";
import { resolveBinding } from "../plan/binding-resolution.js";
import { planNodeResult } from "../plan/binding-resolution.js";
import type { RuntimeExecution } from "../../runner/profile/runtime-profile.js";

export function executeNestedWorkflow(
  runContext: EffectPlanRunContext,
  parent: ExecutionContext,
  node: WorkflowNode,
  abortSignal: AbortSignal,
  execution: RuntimeExecution,
  runChildPlan: (
    context: EffectPlanRunContext,
    input: unknown,
  ) => Effect.Effect<EffectPlanRunResult, unknown>,
  deferCompletion = false,
): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    const invocationId = parent.invocationIds.get(node.nodeId);
    if (invocationId === undefined) {
      return yield* Effect.fail(
        new Error(`No Invocation ID allocated for Plan node "${node.nodeId}"`),
      );
    }
    const child = parent.workflowDefinitions?.get(node.workflowId);
    if (child === undefined) {
      return yield* Effect.fail(
        new Error(
          `No nested workflow definition registered for "${node.workflowId}"`,
        ),
      );
    }
    let rawInput: unknown;
    let parsedInput: unknown;
    try {
      rawInput = resolveBinding(
        node.input,
        parent.workflowInput,
        parent.results,
      );
      parsedInput = child.workflow.input.parse(rawInput);
    } catch (cause) {
      return yield* Effect.fail(
        new InputValidationError(child.workflow.id, cause),
      );
    }
    if (abortSignal.aborted) {
      return yield* Effect.fail(
        abortSignal.aborted
          ? abortSignal.reason
          : new Error("Nested workflow cancelled"),
      );
    }

    const runChild = Effect.gen(function* () {
      if (abortSignal.aborted) {
        return yield* Effect.fail(
          abortSignal.aborted
            ? abortSignal.reason
            : new Error("Nested workflow cancelled"),
        );
      }
      parent.events.emit({
        type: "invocation.started",
        workId: parent.workId,
        runId: parent.runId,
        invocationId,
        subject: { type: "workflow", workflowId: node.workflowId },
      });
      parent.events.emit({
        type: "invocation.input",
        workId: parent.workId,
        runId: parent.runId,
        invocationId,
        input: toSeqlaneDisplayValue(parsedInput),
      });
      parent.events.emit({
        type: "invocation.progress",
        workId: parent.workId,
        runId: parent.runId,
        invocationId,
        state: "active",
        phase: "execute",
        message: "Executing workflow",
        workspace: node.workspace,
      });

      const childContext: EffectPlanRunContext = {
        ...runContext,
        workflow: child,
        input: rawInput,
        runState: parent.runState,
        workspaceOwnerAncestors: [
          ...parent.workspaceOwnerAncestors,
          invocationId,
        ],
        parentInvocationId: invocationId,
        workspaceResources: parent.workspaceResources,
        createInvocationId: (childNodeId) =>
          `${invocationId}:${childNodeId ?? "run"}`,
      };
      return yield* runChildPlan(childContext, parsedInput);
    });

    const workspace = parent.workspaceResources.get(node.workflowId);
    const workspaceResources = [
      ...(workspace?.resources ?? (workspace ? [workspace] : [])),
    ].sort((left, right) => left.key.localeCompare(right.key));
    const workspacePolicies = new Map(
      workspaceResources.map(
        (resource) =>
          [
            resource.key,
            node.workspace === "exclusive" ||
            resource.requiredPolicy === "exclusive"
              ? "exclusive"
              : "shared",
          ] as const,
      ),
    );
    const result =
      workspace === undefined
        ? yield* runChild
        : yield* Effect.acquireUseRelease(
            parent.jointAdmissions.acquireEffect({
              signal: abortSignal,
              session: undefined,
              workspace: workspaceResources[0] ?? workspace,
              workspaceResources,
              workspacePolicies,
              workspacePolicy: node.workspace,
              invocationId,
              ownerAncestors: parent.workspaceOwnerAncestors,
              creationOrdinal: invocationCreationOrdinal(parent, invocationId),
              onWorkspaceWaiting: (blockingInvocationId) =>
                parent.events.emit({
                  type: "invocation.progress",
                  workId: parent.workId,
                  runId: parent.runId,
                  invocationId,
                  state: "waiting",
                  phase: "admission",
                  waitingReason: "workspace_unavailable",
                  workspace: node.workspace,
                  ...(blockingInvocationId === undefined
                    ? {}
                    : { blockingInvocationId }),
                }),
              onSessionWaiting: () => undefined,
            }),
            () => runChild,
            (admission) =>
              Effect.sync(() => {
                for (const lease of admission.workspaceLeases ?? [
                  admission.workspaceLease,
                ]) {
                  lease.release();
                }
                parent.events.emit({
                  type: "invocation.progress",
                  workId: parent.workId,
                  runId: parent.runId,
                  invocationId,
                  state: "active",
                  phase: "workspace_released",
                  workspace: node.workspace,
                });
              }),
          );
    if (result.status === "failed") return yield* Effect.fail(result.error);
    if (result.status === "cancelled") {
      return yield* Effect.fail(
        abortSignal.aborted
          ? abortSignal.reason
          : new Error("Nested workflow cancelled"),
      );
    }
    parent.results.set(node.nodeId, planNodeResult(result.output));
    if (deferCompletion) return result.output;
    parent.events.emit({
      type: "invocation.result",
      workId: parent.workId,
      runId: parent.runId,
      invocationId,
      result: toSeqlaneDisplayValue(result.output),
    });
    parent.events.emit({
      type: "invocation.succeeded",
      workId: parent.workId,
      runId: parent.runId,
      invocationId,
    });
    return result.output;
  });
}
