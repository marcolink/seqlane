import type { ResolvedExecutorSession } from "./session-resolution.js";

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
  readonly resolve: (lease: SessionLockLease) => void;
  readonly reject: (cause: unknown) => void;
}

interface SessionLockState {
  busy: boolean;
  quarantined: QuarantinedSessionError | undefined;
  readonly waiting: WaitingSessionLock[];
}

/** Private exclusive admission with a creation-ordered queue. */
export class SessionLockRegistry {
  readonly #locks = new Map<symbol, SessionLockState>();
  readonly #changeWaiters = new Set<() => void>();

  acquire(
    session: ResolvedExecutorSession,
    onWaiting?: () => void,
    creationOrdinal = Number.MAX_SAFE_INTEGER,
    signal?: AbortSignal,
  ): Promise<SessionLockLease> {
    const state = this.#locks.get(session.key) ?? this.#createState(session);
    if (state.quarantined !== undefined) {
      return Promise.reject(state.quarantined);
    }
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason ?? new Error("Session admission cancelled"),
      );
    }
    if (!state.busy) {
      return Promise.resolve(this.#createLease(session.key, state));
    }

    onWaiting?.();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const resolveWaiting = (lease: SessionLockLease): void => {
        cleanup();
        resolve(lease);
      };
      const rejectWaiting = (cause: unknown): void => {
        cleanup();
        reject(cause);
      };
      const onAbort = (): void => {
        const index = state.waiting.indexOf(waitingEntry);
        if (index === -1) return;
        state.waiting.splice(index, 1);
        rejectWaiting(
          signal?.reason ?? new Error("Session admission cancelled"),
        );
        this.#notifyChange();
      };
      const waitingEntry: WaitingSessionLock = {
        creationOrdinal,
        resolve: resolveWaiting,
        reject: rejectWaiting,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      state.waiting.push(waitingEntry);
      state.waiting.sort(
        (first, second) => first.creationOrdinal - second.creationOrdinal,
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

  waitForChange(): Promise<void> {
    return new Promise((resolve) => this.#changeWaiters.add(resolve));
  }

  quarantine(session: ResolvedExecutorSession, cause: unknown): void {
    const state = this.#locks.get(session.key) ?? this.#createState(session);
    if (state.quarantined !== undefined) return;

    const error = new QuarantinedSessionError(cause);
    state.quarantined = error;
    for (const waiting of state.waiting.splice(0)) waiting.reject(error);
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
    this.#notifyChange();
    if (state.quarantined !== undefined) return;
    const waiting = state.waiting.shift();
    if (waiting === undefined) {
      state.busy = false;
      this.#locks.delete(sessionKey);
      return;
    }

    waiting.resolve(this.#createLease(sessionKey, state));
  }

  #notifyChange(): void {
    for (const resolve of this.#changeWaiters) resolve();
    this.#changeWaiters.clear();
  }
}
