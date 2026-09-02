import type { WorkspaceResource } from "./workspace-resource.js";

import type { WorkspacePolicy } from "@seqlane/core";

export type WorkspaceAdmission = WorkspacePolicy;

export interface WorkspaceLockLease {
  release(): void;
}

interface WaitingWorkspaceLock {
  readonly policy: WorkspaceAdmission;
  readonly creationOrdinal: number;
  readonly invocationId: string;
  readonly resolve: (lease: WorkspaceLockLease) => void;
}

interface WorkspaceLockState {
  readonly readers: Set<string>;
  writerInvocationId: string | undefined;
  readonly waiting: WaitingWorkspaceLock[];
}

/** Private workspace admission primitive with creation-ordered queues. */
export class WorkspaceLockRegistry {
  readonly #locks = new Map<string, WorkspaceLockState>();
  readonly #changeWaiters = new Set<() => void>();
  #nextAnonymousInvocation = 0;

  acquire(
    resource: WorkspaceResource,
    policy: WorkspaceAdmission,
    onWaiting?: (blockingInvocationId: string | undefined) => void,
    creationOrdinal = Number.MAX_SAFE_INTEGER,
    invocationId?: string,
  ): Promise<WorkspaceLockLease> {
    const holderId =
      invocationId ?? `anonymous:${this.#nextAnonymousInvocation++}`;
    const state = this.#locks.get(resource.key) ?? this.#createState(resource);

    if (
      policy === "shared" &&
      state.writerInvocationId === undefined &&
      state.waiting.length === 0
    ) {
      return Promise.resolve(
        this.#createLease(resource.key, state, policy, holderId),
      );
    }

    if (
      policy === "exclusive" &&
      state.writerInvocationId === undefined &&
      state.readers.size === 0 &&
      state.waiting.length === 0
    ) {
      return Promise.resolve(
        this.#createLease(resource.key, state, policy, holderId),
      );
    }

    onWaiting?.(
      state.writerInvocationId ?? state.readers.values().next().value,
    );
    return new Promise((resolve) => {
      state.waiting.push({
        policy,
        creationOrdinal,
        invocationId: holderId,
        resolve,
      });
      state.waiting.sort(
        (first, second) => first.creationOrdinal - second.creationOrdinal,
      );
    });
  }

  tryAcquire(
    resource: WorkspaceResource,
    policy: WorkspaceAdmission,
    onWaiting?: (blockingInvocationId: string | undefined) => void,
    invocationId?: string,
  ): WorkspaceLockLease | undefined {
    const holderId =
      invocationId ?? `anonymous:${this.#nextAnonymousInvocation++}`;
    const state = this.#locks.get(resource.key) ?? this.#createState(resource);
    const available =
      state.waiting.length === 0 &&
      state.writerInvocationId === undefined &&
      (policy === "shared" || state.readers.size === 0);
    if (!available) {
      onWaiting?.(
        state.writerInvocationId ?? state.readers.values().next().value,
      );
      return undefined;
    }
    return this.#createLease(resource.key, state, policy, holderId);
  }

  isAvailable(
    resource: WorkspaceResource,
    policy: WorkspaceAdmission,
  ): boolean {
    const state = this.#locks.get(resource.key);
    return (
      state === undefined ||
      (state.waiting.length === 0 &&
        state.writerInvocationId === undefined &&
        (policy === "shared" || state.readers.size === 0))
    );
  }

  blockingInvocationId(resource: WorkspaceResource): string | undefined {
    const state = this.#locks.get(resource.key);
    return state?.writerInvocationId ?? state?.readers.values().next().value;
  }

  waitForChange(): Promise<void> {
    return new Promise((resolve) => this.#changeWaiters.add(resolve));
  }

  #createState(resource: WorkspaceResource): WorkspaceLockState {
    const state: WorkspaceLockState = {
      readers: new Set(),
      writerInvocationId: undefined,
      waiting: [],
    };
    this.#locks.set(resource.key, state);
    return state;
  }

  #createLease(
    resourceKey: string,
    state: WorkspaceLockState,
    policy: WorkspaceAdmission,
    invocationId: string,
  ): WorkspaceLockLease {
    if (policy === "shared") state.readers.add(invocationId);
    else state.writerInvocationId = invocationId;

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#release(resourceKey, state, policy, invocationId);
      },
    };
  }

  #release(
    resourceKey: string,
    state: WorkspaceLockState,
    policy: WorkspaceAdmission,
    invocationId: string,
  ): void {
    this.#notifyChange();
    if (policy === "shared") state.readers.delete(invocationId);
    else state.writerInvocationId = undefined;

    this.#grantWaiting(resourceKey, state);
    if (
      state.writerInvocationId === undefined &&
      state.readers.size === 0 &&
      state.waiting.length === 0
    ) {
      this.#locks.delete(resourceKey);
    }
  }

  #grantWaiting(resourceKey: string, state: WorkspaceLockState): void {
    if (state.writerInvocationId !== undefined || state.waiting.length === 0) {
      return;
    }

    const first = state.waiting[0];
    if (first === undefined) return;
    if (first.policy === "exclusive") {
      if (state.readers.size > 0) return;
      state.waiting.shift();
      first.resolve(
        this.#createLease(resourceKey, state, "exclusive", first.invocationId),
      );
      return;
    }

    while (state.waiting[0]?.policy === "shared") {
      const reader = state.waiting.shift();
      if (reader === undefined) return;
      reader.resolve(
        this.#createLease(resourceKey, state, "shared", reader.invocationId),
      );
    }
  }

  #notifyChange(): void {
    for (const resolve of this.#changeWaiters) resolve();
    this.#changeWaiters.clear();
  }
}
