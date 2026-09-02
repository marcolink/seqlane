import { realpath } from "node:fs/promises";
import type { TaskDefinitionRegistry, TaskId } from "@seqlane/core";

export interface WorkspaceIdentity {
  readonly path: string;
}

export type WorkspaceIdentityRegistry = ReadonlyMap<TaskId, WorkspaceIdentity>;

export class WorkspaceResolutionError extends Error {
  constructor(workspacePath: string, cause: unknown) {
    super(`Could not resolve workspace "${workspacePath}"`, { cause });
    this.name = "WorkspaceResolutionError";
  }
}

/** Resolves runtime workspace configuration to the canonical admission identity. */
export async function resolveWorkspaceIdentity(
  workspacePath: string,
): Promise<WorkspaceIdentity> {
  try {
    return { path: await realpath(workspacePath) };
  } catch (cause) {
    throw new WorkspaceResolutionError(workspacePath, cause);
  }
}

export async function resolveTaskWorkspaceIdentities(
  taskDefinitions: TaskDefinitionRegistry,
  workspacePath: string | undefined,
): Promise<WorkspaceIdentityRegistry> {
  const identity =
    workspacePath === undefined
      ? { path: "seqlane:runtime-workspace" }
      : await resolveWorkspaceIdentity(workspacePath);
  return createTaskWorkspaceIdentities(taskDefinitions, identity);
}

export function createTaskWorkspaceIdentities(
  taskDefinitions: TaskDefinitionRegistry,
  identity: WorkspaceIdentity,
): WorkspaceIdentityRegistry {
  return new Map(
    [...taskDefinitions.values()].map((task) => [task.id, identity]),
  );
}
