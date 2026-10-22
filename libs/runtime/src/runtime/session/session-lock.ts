import { Deferred, Effect, Exit, Option } from "effect";
import type { ResolvedExecutorSession } from "./session-resolution.js";
import { awaitAbort } from "../execution/await-abort.js";

export interface SessionLockLease {
  release(): void;
}

export class QuarantinedSessionError extends Error {
  constructor(cause: unknown) {
    super("Executor session is quarantined for this Run", { cause });
    this.name = "QuarantinedSessionError";
  }
}

interface WaitingSessionLock {
  readonly creationOrdinal: number;
  readonly changed: Deferred.Deferred<SessionLockLease, unknown>;
}

interface SessionLockState {
  busy: boolean;
  quarantined: QuarantinedSessionError | undefined;
  readonly waiting: WaitingSessionLock[];
}

/** Private exclusive admission with a creation-ordered Effect queue. */
export class SessionLockRegistry {
  readonly #locks = new Map<symbol, SessionLockState>();
  readonly #changeListeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Promise task callbacks enter the native admission queue at this edge. */
  acquire(
    session: ResolvedExecutorSession,
    onWaiting?: () => void,
    creationOrdinal = Number.MAX_SAFE_INTEGER,
    signal?: AbortSignal,
  ): Promise<SessionLockLease> {
    return Effect.runPromise(
      this.acquireEffect(session, onWaiting, creationOrdinal, signal),
    );
  }

  acquireEffect(
    session: ResolvedExecutorSession,
    onWaiting?: () => void,
    creationOrdinal = Number.MAX_SAFE_INTEGER,
    signal?: AbortSignal,
  ): Effect.Effect<SessionLockLease, unknown> {
    return Effect.suspend(() => {
      const state = this.#locks.get(session.key) ?? this.#createState(session);
      if (state.quarantined !== undefined)
        return Effect.fail(state.quarantined);
      if (signal?.aborted)
        return Effect.fail(
          signal.reason ?? new Error("Session admission cancelled"),
        );
      if (!state.busy && state.waiting.length === 0)
        return Effect.succeed(this.#createLease(session.key, state));

      onWaiting?.();
      const waiting: WaitingSessionLock = {
        creationOrdinal,
        changed: Deferred.makeUnsafe<SessionLockLease, unknown>(),
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
              awaitAbort(signal, "Session admission cancelled"),
            ),
        (exit) =>
          Effect.sync(() =>
            this.#removeWaiting(session.key, state, waiting),
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
    session: ResolvedExecutorSession,
    onWaiting?: () => void,
  ): SessionLockLease | undefined {
    const state = this.#locks.get(session.key) ?? this.#createState(session);
    if (state.quarantined !== undefined) throw state.quarantined;
    if (state.busy || state.waiting.length > 0) {
      onWaiting?.();
      return undefined;
    }
    return this.#createLease(session.key, state);
  }

  isAvailable(session: ResolvedExecutorSession): boolean {
    const state = this.#locks.get(session.key);
    if (state?.quarantined !== undefined) throw state.quarantined;
    return state === undefined || (!state.busy && state.waiting.length === 0);
  }

  hasEffectWaiterTurn(
    session: ResolvedExecutorSession,
    ordinal: number,
  ): boolean {
    const state = this.#locks.get(session.key);
    if (state?.quarantined !== undefined) throw state.quarantined;
    return !(state?.waiting ?? []).some(
      (waiter) => waiter.creationOrdinal < ordinal,
    );
  }

  quarantine(session: ResolvedExecutorSession, cause: unknown): void {
    const state = this.#locks.get(session.key) ?? this.#createState(session);
    if (state.quarantined !== undefined) return;
    const error = new QuarantinedSessionError(cause);
    state.quarantined = error;
    for (const waiting of state.waiting.splice(0)) {
      Deferred.doneUnsafe(waiting.changed, Effect.fail(error));
    }
    this.#notifyChange();
  }

  #createState(session: ResolvedExecutorSession): SessionLockState {
    const state: SessionLockState = {
      busy: false,
      quarantined: undefined,
      waiting: [],
    };
    this.#locks.set(session.key, state);
    return state;
  }

  #createLease(sessionKey: symbol, state: SessionLockState): SessionLockLease {
    state.busy = true;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#release(sessionKey, state);
      },
    };
  }

  #release(sessionKey: symbol, state: SessionLockState): void {
    if (state.quarantined !== undefined) {
      this.#notifyChange();
      return;
    }
    const waiting = state.waiting.shift();
    if (waiting === undefined) {
      state.busy = false;
      this.#locks.delete(sessionKey);
      this.#notifyChange();
      return;
    }
    const lease = this.#createLease(sessionKey, state);
    Deferred.doneUnsafe(waiting.changed, Effect.succeed(lease));
    this.#notifyChange();
  }

  #removeWaiting(
    sessionKey: symbol,
    state: SessionLockState,
    waiting: WaitingSessionLock,
  ): void {
    const index = state.waiting.indexOf(waiting);
    if (index === -1) return;
    state.waiting.splice(index, 1);
    this.#grantNext(sessionKey, state);
    this.#notifyChange();
  }

  #grantNext(sessionKey: symbol, state: SessionLockState): void {
    if (state.busy || state.quarantined !== undefined) return;
    const waiting = state.waiting.shift();
    if (waiting === undefined) {
      this.#locks.delete(sessionKey);
      return;
    }
    const lease = this.#createLease(sessionKey, state);
    Deferred.doneUnsafe(waiting.changed, Effect.succeed(lease));
  }

  #notifyChange(): void {
    for (const listener of this.#changeListeners) listener();
  }
}
