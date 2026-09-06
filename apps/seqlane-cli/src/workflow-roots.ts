import {
  defaultWorkflowRoots,
  type WorkflowRoots,
} from "./workflow-discovery.js";

export function workflowRootsFromFlags(flags: {
  readonly "repository-root"?: string;
  readonly "user-root"?: string;
}): WorkflowRoots {
  const defaults = defaultWorkflowRoots();
  return {
    repository: flags["repository-root"] ?? defaults.repository,
    user: flags["user-root"] ?? defaults.user,
  };
}
