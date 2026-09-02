import type { TaskId } from "@seqlane/core";
import type { WorkspaceIdentityRegistry } from "./workspace-identity.js";

export interface WorkspaceResource {
  readonly key: string;
}

export type WorkspaceResourceRegistry = ReadonlyMap<TaskId, WorkspaceResource>;

export class WorkspaceResourceResolutionError extends Error {
  constructor(taskId: TaskId) {
    super(`No workspace resource resolved for task "${taskId}"`);
    this.name = "WorkspaceResourceResolutionError";
  }
}

/** V1 uses a whole canonical checkout as one lockable workspace resource. */
export function createWorkspaceResources(
  identities: WorkspaceIdentityRegistry,
): WorkspaceResourceRegistry {
  const resourcesByKey = new Map<string, WorkspaceResource>();
  const resourcesByTaskId = new Map<TaskId, WorkspaceResource>();

  for (const [taskId, identity] of identities) {
    const resource = resourcesByKey.get(identity.path) ?? {
      key: identity.path,
    };
    resourcesByKey.set(resource.key, resource);
    resourcesByTaskId.set(taskId, resource);
  }

  return resourcesByTaskId;
}
