import type { EventDispatcher } from "./event-dispatcher.js";
import { closeOwnedResources } from "./run-cleanup.js";

export interface RunLifecycleOptions {
  readonly dispatcher?: EventDispatcher;
  readonly closeClient?: () => void | Promise<void>;
  readonly finishRenderer?: () => void | Promise<void>;
}

/** Closes supervised-run resources in dependency order. */
export function closeRunResources(
  options: RunLifecycleOptions,
): Promise<readonly unknown[]> {
  return closeOwnedResources([
    () => options.closeClient?.(),
    () => options.dispatcher?.flush(),
    () => options.dispatcher?.close(),
    () => options.finishRenderer?.(),
  ]);
}
