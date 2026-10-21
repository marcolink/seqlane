import { Deferred, Effect, Exit, Option } from "effect";
import type { WorkspacePolicy } from "@seqlane/core";
import type { WorkspaceResource } from "./workspace-resource.js";
import { awaitAbort } from "../execution/await-abort.js";

export type WorkspaceAdmission = WorkspacePolicy;

export interface WorkspaceLockLease {
  release(): void;
}

export class QuarantinedWorkspaceError extends Error {
  constructor(cause: unknown) {
    super("Workspace is quarantined for this Run", { cause });
    this.name = "QuarantinedWorkspaceError";
  }
}

interface WaitingWorkspaceLock {
  readonly policy: WorkspaceAdmission;
  readonly creationOrdinal: number;
  readonly invocationId: string;
  readonly ownerId: string;
  readonly changed: Deferred.Deferred<WorkspaceLockLease, unknown>;
}

interface WorkspaceLockState {
  readonly readers: Map<string, number>;
  writerInvocationId: string | undefined;
  writerDepth: number;
  quarantined: QuarantinedWorkspaceError | undefined;
  readonly waiting: WaitingWorkspaceLock[];
}

/** Private workspace admission primitive with a creation-ordered Effect queue. */
export class WorkspaceLockRegistry {
  readonly #locks = new Map<string, WorkspaceLockState>();
  readonly #changeListeners = new Set<() => void>();
  #nextAnonymousInvocation = 0;

  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Promise compatibility boundary for legacy runtime callers. */
  acquire(
    resource: WorkspaceResource,
    policy: WorkspaceAdmission,
    onWaiting?: (blockingInvocationId: string | undefined) => void,
    creationOrdinal = Number.MAX_SAFE_INTEGER,
    invocationId?: string,
    ownerId?: string,
  ): Promise<WorkspaceLockLease> {
    return Effect.runPromise(
      this.acquireEffect(
        resource,
        policy,
        onWaiting,
        creationOrdinal,
        invocationId,
        ownerId,
      ),
    );
  }

  acquireEffect(
    resource: WorkspaceResource,
    policy: WorkspaceAdmission,
    onWaiting?: (blockingInvocationId: string | undefined) => void,
    creationOrdinal = Number.MAX_SAFE_INTEGER,
    invocationId?: string,
    ownerId?: string,
    signal?: AbortSignal,
  ): Effect.Effect<WorkspaceLockLease, unknown> {
    return Effect.suspend(() => {
      const holderId =
        invocationId ?? `anonymous:${this.#nextAnonymousInvocation++}`;
      const owner = ownerId ?? holderId;
      const state =
        this.#locks.get(resource.key) ?? this.#createState(resource);
      if (state.quarantined !== undefined)
        return Effect.fail(state.quarantined);
      if (signal?.aborted)
        return Effect.fail(
          signal.reason ?? new Error("Workspace admission cancelled"),
        );
      if (state.writerInvocationId === owner) {
        state.writerDepth += 1;
        return Effect.succeed(
          this.#createLease(resource.key, state, "exclusive", owner),
        );
      }
      if (this.#isAvailable(state, policy))
        return Effect.succeed(
          this.#createLease(resource.key, state, policy, owner),
        );

      onWaiting?.(this.#blockingInvocationId(state));
      const waiting: WaitingWorkspaceLock = {
        policy,
        creationOrdinal,
        invocationId: holderId,
        ownerId: owner,
        changed: Deferred.makeUnsafe<WorkspaceLockLease, unknown>(),
      };
      state.waiting.push(waiting);
      state.waiting.sort(
        (first, second) => first.creationOrdinal - second.creationOrdinal,
      );
      return Effect.onExit(
        signal === undefined
          ? Deferred.await(waiting.changed)
          : Effect.raceFirst(
              Deferred.await(waiting.changed),
              awaitAbort(signal, "Workspace admission cancelled"),
            ),
        (exit) =>
          Effect.sync(() =>
            this.#removeWaiting(resource.key, state, waiting),
          ).pipe(
            Effect.andThen(
              Exit.isFailure(exit)
                ? Effect.flatMap(Deferred.poll(waiting.changed), (completed) =>
                    Option.match(completed, {
                      onNone: () => Effect.void,
                      onSome: (handoffEffect) =>
                        Effect.result(handoffEffect).pipe(
                          Effect.flatMap((handoff) =>
                            handoff._tag === "Success"
                              ? Effect.sync(() => handoff.success.release())
                              : Effect.void,
                          ),
                        ),
                    }),
                  )
                : Effect.void,
            ),
          ),
      );
    });
  }

  tryAcquire(
    resource: WorkspaceResource,
    policy: WorkspaceAdmission,
    onWaiting?: (blockingInvocationId: string | undefined) => void,
    invocationId?: string,
    ownerId?: string,
  ): WorkspaceLockLease | undefined {
    const holderId =
      invocationId ?? `anonymous:${this.#nextAnonymousInvocation++}`;
    const owner = ownerId ?? holderId;
    const state = this.#locks.get(resource.key) ?? this.#createState(resource);
    if (state.quarantined !== undefined) throw state.quarantined;
    if (state.writerInvocationId === owner) {
      state.writerDepth += 1;
      return this.#createLease(resource.key, state, "exclusive", owner);
    }
    if (!this.#isAvailable(state, policy)) {
      onWaiting?.(this.#blockingInvocationId(state));
      return undefined;
    }
    return this.#createLease(resource.key, state, policy, owner);
  }

  isAvailable(
    resource: WorkspaceResource,
    policy: WorkspaceAdmission,
    ownerId?: string,
  ): boolean {
    const state = this.#locks.get(resource.key);
    if (state?.quarantined !== undefined) throw state.quarantined;
    if (ownerId !== undefined && state?.writerInvocationId === ownerId)
      return true;
    return state === undefined || this.#isAvailable(state, policy);
  }

  canEffectWaiterProceed(
    resource: WorkspaceResource,
    policy: WorkspaceAdmission,
    ordinal: number,
    ownerId: string | undefined,
    waiting: readonly {
      readonly policy: WorkspaceAdmission;
      readonly creationOrdinal: number;
    }[],
  ): boolean {
    const state = this.#locks.get(resource.key);
    if (state?.quarantined !== undefined) throw state.quarantined;
    if (ownerId !== undefined && state?.writerInvocationId === ownerId)
      return true;
    return !waiting.some(
      (waiter) =>
        waiter.creationOrdinal < ordinal &&
        (policy === "exclusive" || waiter.policy === "exclusive"),
    );
  }

  blockingInvocationId(resource: WorkspaceResource): string | undefined {
    const state = this.#locks.get(resource.key);
    return state === undefined ? undefined : this.#blockingInvocationId(state);
  }

  quarantine(resource: WorkspaceResource, cause: unknown): void {
    const state = this.#locks.get(resource.key) ?? this.#createState(resource);
    if (state.quarantined !== undefined) return;
    const error = new QuarantinedWorkspaceError(cause);
    state.quarantined = error;
    for (const waiting of state.waiting.splice(0)) {
      Deferred.doneUnsafe(waiting.changed, Effect.fail(error));
    }
    this.#notifyChange();
  }

  #createState(resource: WorkspaceResource): WorkspaceLockState {
    const state: WorkspaceLockState = {
      readers: new Map(),
      writerInvocationId: undefined,
      writerDepth: 0,
      quarantined: undefined,
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
    if (policy === "shared") {
      state.readers.set(
        invocationId,
        (state.readers.get(invocationId) ?? 0) + 1,
      );
    } else if (state.writerInvocationId === undefined) {
      state.writerInvocationId = invocationId;
      state.writerDepth = 1;
    }
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
    if (state.quarantined !== undefined) {
      this.#notifyChange();
      return;
    }
    if (policy === "shared") {
      const depth = state.readers.get(invocationId) ?? 0;
      if (depth <= 1) state.readers.delete(invocationId);
      else state.readers.set(invocationId, depth - 1);
    } else if (state.writerInvocationId === invocationId) {
      state.writerDepth -= 1;
      if (state.writerDepth === 0) state.writerInvocationId = undefined;
    }
    this.#grantWaiting(resourceKey, state);
    if (
      state.writerInvocationId === undefined &&
      state.readers.size === 0 &&
      state.waiting.length === 0
    ) {
      this.#locks.delete(resourceKey);
    }
    this.#notifyChange();
  }

  #removeWaiting(
    resourceKey: string,
    state: WorkspaceLockState,
    waiting: WaitingWorkspaceLock,
  ): void {
    const index = state.waiting.indexOf(waiting);
    if (index === -1) return;
    state.waiting.splice(index, 1);
    this.#grantWaiting(resourceKey, state);
    this.#notifyChange();
  }

  #grantWaiting(resourceKey: string, state: WorkspaceLockState): void {
    if (
      state.quarantined !== undefined ||
      state.writerInvocationId !== undefined
    )
      return;
    const first = state.waiting[0];
    if (first === undefined) return;
    if (first.policy === "exclusive") {
      if (state.readers.size > 0) return;
      state.waiting.shift();
      const lease = this.#createLease(
        resourceKey,
        state,
        "exclusive",
        first.ownerId,
      );
      Deferred.doneUnsafe(first.changed, Effect.succeed(lease));
      return;
    }
    while (state.waiting[0]?.policy === "shared") {
      const reader = state.waiting.shift();
      if (reader === undefined) return;
      const lease = this.#createLease(
        resourceKey,
        state,
        "shared",
        reader.ownerId,
      );
      Deferred.doneUnsafe(reader.changed, Effect.succeed(lease));
    }
  }

  #isAvailable(state: WorkspaceLockState, policy: WorkspaceAdmission): boolean {
    return (
      state.waiting.length === 0 &&
      state.writerInvocationId === undefined &&
      (policy === "shared" || state.readers.size === 0)
    );
  }

  #blockingInvocationId(state: WorkspaceLockState): string | undefined {
    return state.writerInvocationId ?? state.readers.keys().next().value;
  }

  #notifyChange(): void {
    for (const listener of this.#changeListeners) listener();
  }
}
