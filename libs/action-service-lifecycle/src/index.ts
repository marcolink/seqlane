export {
  adoptDetachedProcess,
  cleanupDetachedProcess,
  completeDetachedProcessHandoff,
  spawnDetached,
  type DetachedProcess,
  type SpawnDetachedOptions,
} from "./lifecycle.js";
export { SpawnDetachedError, ServiceLifecycleError } from "./errors.js";
export { readProcessIdentity } from "./process-identity.js";
export { terminateProcessGroup } from "./termination.js";
export {
  detachedProcessOwnershipSchema,
  processIdentitySchema,
  processMemberSchema,
  type DetachedProcessOwnership,
  type ProcessIdentity,
  type ProcessMember,
} from "./schemas.js";

export { assertDirectory } from "./directory.js";
