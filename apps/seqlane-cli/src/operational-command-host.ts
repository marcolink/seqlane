import type { JsonValue, WorkflowReference } from "@seqlane/core";
import {
  createOperationalHost,
  createOperationalWorkflow,
  type OperationalHost,
} from "@seqlane/runtime/operational-host";
import { loadWorkflow } from "@seqlane/runtime/workflow";
import { loadOperationalWorkflows } from "./commands/serve.js";
import type { WorkflowRoots } from "./workflow-discovery.js";

export interface OwnedOperationalHostOptions {
  readonly roots: WorkflowRoots;
  readonly workflow?: WorkflowReference;
  readonly workflowInput?: JsonValue;
  readonly storageUrl?: string;
  readonly host?: string;
  readonly port?: number;
}

export async function startOwnedOperationalHost(
  options: OwnedOperationalHostOptions,
): Promise<OperationalHost> {
  const workflows = [...(await loadOperationalWorkflows(options.roots))];
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
        taskDefinitions: loaded.taskDefinitions,
        validatorDefinitions: loaded.validatorDefinitions,
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
