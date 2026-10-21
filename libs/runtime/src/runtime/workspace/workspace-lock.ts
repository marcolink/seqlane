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
  readonly ownerAncestors: readonly string[];
  readonly changed: Deferred.Deferred<WorkspaceLockLease, unknown>;
}

interface WorkspaceLockState {
  readonly holders: Map<
    string,
    {
      readonly policy: WorkspaceAdmission;
      readonly ancestors: readonly string[];
      depth: number;
    }
  >;
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
    ownerAncestors: readonly string[] = [],
  ): Promise<WorkspaceLockLease> {
    return Effect.runPromise(
      this.acquireEffect(
        resource,
        policy,
        onWaiting,
        creationOrdinal,
        invocationId,
        ownerId,
        ownerAncestors,
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
    ownerAncestors: readonly string[] = [],
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
      const ancestorAdmission = this.#hasAncestorHolder(state, ownerAncestors);
      const queuedAhead = state.waiting.length > 0;
      if (
        this.#isAvailable(state, policy, owner, ownerAncestors) &&
        (ancestorAdmission || !queuedAhead)
      )
        return Effect.succeed(
          this.#createLease(resource.key, state, policy, owner, ownerAncestors),
        );

      onWaiting?.(this.#blockingInvocationId(state));
      const waiting: WaitingWorkspaceLock = {
        policy,
        creationOrdinal,
        invocationId: holderId,
        ownerId: owner,
        ownerAncestors,
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
    ownerAncestors: readonly string[] = [],
  ): WorkspaceLockLease | undefined {
    const holderId =
      invocationId ?? `anonymous:${this.#nextAnonymousInvocation++}`;
    const owner = ownerId ?? holderId;
    const state = this.#locks.get(resource.key) ?? this.#createState(resource);
    if (state.quarantined !== undefined) throw state.quarantined;
    if (!this.#isAvailable(state, policy, owner, ownerAncestors)) {
      onWaiting?.(this.#blockingInvocationId(state));
      return undefined;
    }
    return this.#createLease(
      resource.key,
      state,
      policy,
      owner,
      ownerAncestors,
    );
  }

  isAvailable(
    resource: WorkspaceResource,
    policy: WorkspaceAdmission,
    ownerId?: string,
    ownerAncestors: readonly string[] = [],
  ): boolean {
    const state = this.#locks.get(resource.key);
    if (state?.quarantined !== undefined) throw state.quarantined;
    return (
      state === undefined ||
      this.#isAvailable(state, policy, ownerId ?? "", ownerAncestors)
    );
  }

  canEffectWaiterProceed(
    resource: WorkspaceResource,
    policy: WorkspaceAdmission,
    ordinal: number,
    ownerAncestors: readonly string[],
    waiting: readonly {
      readonly policy: WorkspaceAdmission;
      readonly creationOrdinal: number;
      readonly ownerAncestors?: readonly string[];
    }[],
  ): boolean {
    const state = this.#locks.get(resource.key);
    if (state?.quarantined !== undefined) throw state.quarantined;
    const parentOwner = ownerAncestors.at(-1);
    const hasAncestorReservation = this.#hasAncestorHolder(
      state,
      ownerAncestors,
    );
    const result = !waiting.some(
      (waiter) =>
        waiter.creationOrdinal < ordinal &&
        (policy === "exclusive" || waiter.policy === "exclusive") &&
        (!hasAncestorReservation ||
          waiter.ownerAncestors?.at(-1) === parentOwner),
    );
    return result;
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
      holders: new Map(),
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
    ownerAncestors: readonly string[] = [],
  ): WorkspaceLockLease {
    const existing = state.holders.get(invocationId);
    if (existing !== undefined) existing.depth += 1;
    else
      state.holders.set(invocationId, {
        policy,
        ancestors: ownerAncestors,
        depth: 1,
      });
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#release(resourceKey, state, invocationId);
      },
    };
  }

  #release(
    resourceKey: string,
    state: WorkspaceLockState,
    invocationId: string,
  ): void {
    if (state.quarantined !== undefined) {
      this.#notifyChange();
      return;
    }
    const holder = state.holders.get(invocationId);
    if (holder !== undefined) {
      holder.depth -= 1;
      if (holder.depth <= 0) state.holders.delete(invocationId);
    }
    this.#grantWaiting(resourceKey, state);
    if (state.holders.size === 0 && state.waiting.length === 0) {
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
    if (state.quarantined !== undefined) return;
    const ancestorWaiter = state.waiting.find((waiting) =>
      this.#hasAncestorHolder(state, waiting.ownerAncestors),
    );
    const first = ancestorWaiter ?? state.waiting[0];
    if (first === undefined) return;
    if (
      !this.#isAvailable(
        state,
        first.policy,
        first.ownerId,
        first.ownerAncestors,
      )
    )
      return;
    if (first.policy === "exclusive") {
      state.waiting.splice(state.waiting.indexOf(first), 1);
      const lease = this.#createLease(
        resourceKey,
        state,
        "exclusive",
        first.ownerId,
        first.ownerAncestors,
      );
      Deferred.doneUnsafe(first.changed, Effect.succeed(lease));
      return;
    }
    const firstWriterIndex = state.waiting.findIndex(
      (waiting) => waiting.policy === "exclusive",
    );
    const sharedWaiters = state.waiting.filter(
      (waiting, index) =>
        waiting.policy === "shared" &&
        (firstWriterIndex === -1 ||
          index < firstWriterIndex ||
          this.#hasAncestorHolder(state, waiting.ownerAncestors)) &&
        this.#isAvailable(
          state,
          "shared",
          waiting.ownerId,
          waiting.ownerAncestors,
        ),
    );
    for (const reader of sharedWaiters) {
      state.waiting.splice(state.waiting.indexOf(reader), 1);
      const lease = this.#createLease(
        resourceKey,
        state,
        "shared",
        reader.ownerId,
        reader.ownerAncestors,
      );
      Deferred.doneUnsafe(reader.changed, Effect.succeed(lease));
    }
  }

  #isAvailable(
    state: WorkspaceLockState,
    policy: WorkspaceAdmission,
    ownerId: string,
    ownerAncestors: readonly string[],
  ): boolean {
    return [...state.holders.entries()].every(([holderId, holder]) => {
      if (
        holderId === ownerId ||
        ownerAncestors.includes(holderId) ||
        holder.ancestors.includes(ownerId)
      )
        return true;
      return policy === "shared" && holder.policy === "shared";
    });
  }

  #blockingInvocationId(state: WorkspaceLockState): string | undefined {
    const writer = [...state.holders].find(
      ([, holder]) => holder.policy === "exclusive",
    )?.[0];
    return writer ?? state.holders.keys().next().value;
  }

  #hasAncestorHolder(
    state: WorkspaceLockState | undefined,
    ownerAncestors: readonly string[],
  ): boolean {
    if (state === undefined) return false;
    return [...state.holders.keys()].some((holderId) =>
      ownerAncestors.includes(holderId),
    );
  }

  #notifyChange(): void {
    for (const listener of this.#changeListeners) listener();
  }
}
