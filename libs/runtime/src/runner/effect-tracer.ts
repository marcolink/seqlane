import { createEffectPlanProgram } from "../runtime/execution/effect-plan.js";
import type { RunnerRunProgram } from "./run.js";

/** Private target Plan composition used by CLI fixtures until the S9 cutover. */
export function createEffectTracerRunProgram(): RunnerRunProgram {
  return (context) =>
    createEffectPlanProgram({
      workflow: context.workflow,
      input: context.request.input,
      workId: context.workId,
      runId: context.runId,
      signal: context.signal,
      events: context.events,
      createInvocationId: context.createInvocationId,
    });
}
