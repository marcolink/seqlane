import type { JsonValue, WorkflowReference } from "@seqlane/core";
import {
  createOperationalHost,
  createOperationalWorkflow,
  type OperationalHost,
  type OperationalEventSink,
  type OperationalSessionUiNotifier,
} from "@seqlane/runtime/operational-host";
import { loadWorkflow } from "@seqlane/runtime/workflow";
import { loadOperationalWorkflows } from "./operational-workflows.js";
import type { WorkflowRoots } from "./workflow-discovery.js";

export interface OwnedOperationalHostOptions {
  readonly roots: WorkflowRoots;
  readonly workflow?: WorkflowReference;
  readonly workflowInput?: JsonValue;
  readonly storageUrl?: string;
  readonly host?: string;
  readonly port?: number;
  readonly eventSink?: (context: {
    readonly workId: string;
    readonly runId: string;
  }) => OperationalEventSink;
  readonly onSessionUiAvailable?: OperationalSessionUiNotifier;
  readonly adapterConfiguration?: unknown;
}

export async function startOwnedOperationalHost(
  options: OwnedOperationalHostOptions,
): Promise<OperationalHost> {
  const workflows = [
    ...(await loadOperationalWorkflows(
      options.roots,
      options.eventSink,
      options.onSessionUiAvailable,
      options.adapterConfiguration,
    )),
  ];
  if (
    options.workflow !== undefined &&
    !workflows.some(({ key }) => key === options.workflow?.id)
  ) {
    const loaded = await loadWorkflow(
      options.workflow,
      options.workflowInput ?? null,
    );
    workflows.push(
      createOperationalWorkflow({
        key: options.workflow.id,
        plan: loaded.plan,
        workflow: loaded.definition,
        taskDefinitions: loaded.taskDefinitions,
        validatorDefinitions: loaded.validatorDefinitions,
        eventSink: options.eventSink,
        onSessionUiAvailable: options.onSessionUiAvailable,
        adapterConfiguration: options.adapterConfiguration,
      }),
    );
  }

  const host = await createOperationalHost({
    workflows,
    host: options.host,
    port: options.port,
    storageUrl: options.storageUrl,
  });
  try {
    await host.listen();
    return host;
  } catch (cause) {
    await host.close().catch(() => undefined);
    throw cause;
  }
}
