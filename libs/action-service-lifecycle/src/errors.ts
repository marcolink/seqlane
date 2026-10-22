import type { DetachedProcessOwnership } from "./schemas.js";

export class ServiceLifecycleError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ServiceLifecycleError";
  }
}

export class SpawnDetachedError extends ServiceLifecycleError {
  readonly cleanupSucceeded: boolean;
  readonly ownership: DetachedProcessOwnership | undefined;

  constructor(
    command: string,
    cause: unknown,
    cleanupSucceeded: boolean,
    ownership?: DetachedProcessOwnership,
  ) {
    super(`Could not start anchored process for ${command}`, cause);
    this.name = "SpawnDetachedError";
    this.cleanupSucceeded = cleanupSucceeded;
    this.ownership = ownership;
  }
}
