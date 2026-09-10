import {
  createOperationalWorkflow,
  type OperationalEventSink,
  type OperationalSessionUiNotifier,
} from "@seqlane/runtime/operational-host";
import { loadWorkflow } from "@seqlane/runtime/workflow";
import {
  discoverWorkflowDescriptors,
  type WorkflowRoots,
} from "./workflow-discovery.js";

export async function loadOperationalWorkflows(
  roots: WorkflowRoots,
  eventSink?: (context: {
    readonly workId: string;
    readonly runId: string;
  }) => OperationalEventSink,
  onSessionUiAvailable?: OperationalSessionUiNotifier,
  adapterConfiguration?: unknown,
): Promise<readonly ReturnType<typeof createOperationalWorkflow>[]> {
  const descriptors = discoverWorkflowDescriptors(roots);
  const registrations = [];
  for (const descriptor of descriptors) {
    const loaded = await loadWorkflow(descriptor.reference, null);
    registrations.push(
      createOperationalWorkflow({
        key: descriptor.qualifiedName,
        plan: loaded.plan,
        workflow: loaded.definition,
        taskDefinitions: loaded.taskDefinitions,
        validatorDefinitions: loaded.validatorDefinitions,
        eventSink,
        onSessionUiAvailable,
        adapterConfiguration,
      }),
    );
  }
  return registrations;
}
