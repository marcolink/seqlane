import { Effect, TxRef } from "effect";
import type { ResolvedExecutorSession } from "./session-resolution.js";
import {
  acquireTransactional,
  admissionSync,
  type AdmissionDecision,
} from "../invocation/transactional-admission.js";

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
  readonly token: symbol;
  readonly creationOrdinal: number;
}

export interface SessionLockState {
  readonly holder?: symbol;
  readonly quarantined?: QuarantinedSessionError;
  readonly waiting: readonly WaitingSessionLock[];
}

export function sessionAvailable(state: SessionLockState | undefined): boolean {
  if (state?.quarantined !== undefined) throw state.quarantined;
  return state?.holder === undefined && (state?.waiting.length ?? 0) === 0;
}

/** Immutable state participates in the same transaction as workspace admission. */
export class SessionLockRegistry {
  readonly state = TxRef.makeUnsafe<ReadonlyMap<symbol, SessionLockState>>(
    new Map(),
  );

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
      const token = Symbol();
      return acquireTransactional({
        signal,
        register: TxRef.update(this.state, (states) => {
          const state = states.get(session.key) ?? { waiting: [] };
          return new Map(states).set(session.key, {
            ...state,
            waiting: [...state.waiting, { token, creationOrdinal }].sort(
              (a, b) => a.creationOrdinal - b.creationOrdinal,
            ),
          });
        }),
        attempt: Effect.gen({ self: this }, function* () {
          const state = (yield* TxRef.get(this.state)).get(session.key);
          if (state?.quarantined !== undefined)
            return yield* Effect.fail(state.quarantined);
          if (state?.holder !== undefined || state?.waiting[0]?.token !== token)
            return {
              _tag: "Waiting",
              reason: "session",
              notify: () => onWaiting?.(),
            } satisfies AdmissionDecision<SessionLockLease>;
          return {
            _tag: "Acquired",
            lease: yield* this.take(session, token),
          } satisfies AdmissionDecision<SessionLockLease>;
        }),
        cleanup: (failed) => this.remove(session.key, token, failed),
      });
    });
  }

  isAvailable(session: ResolvedExecutorSession): boolean {
    return admissionSync(
      TxRef.get(this.state).pipe(
        Effect.map((states) => sessionAvailable(states.get(session.key))),
      ),
    );
  }

  /** Call inside the joint transaction after checking the shared snapshot. */
  take(
    session: ResolvedExecutorSession,
    token: symbol,
  ): Effect.Effect<SessionLockLease> {
    return TxRef.update(this.state, (states) =>
      new Map(states).set(session.key, {
        ...states.get(session.key),
        holder: token,
        waiting: states.get(session.key)?.waiting ?? [],
      }),
    ).pipe(
      Effect.as({
        release: () => admissionSync(this.remove(session.key, token, true)),
      }),
    );
  }

  quarantine(session: ResolvedExecutorSession, cause: unknown): void {
    admissionSync(
      TxRef.update(this.state, (states) => {
        const state = states.get(session.key) ?? { waiting: [] };
        return state.quarantined === undefined
          ? new Map(states).set(session.key, {
              ...state,
              quarantined: new QuarantinedSessionError(cause),
            })
          : states;
      }),
    );
  }

  remove(key: symbol, token: symbol, release: boolean): Effect.Effect<void> {
    return TxRef.update(this.state, (states) => {
      const state = states.get(key);
      if (state === undefined) return states;
      const next = {
        ...state,
        holder:
          release && state.holder === token && state.quarantined === undefined
            ? undefined
            : state.holder,
        waiting: state.waiting.filter((waiter) => waiter.token !== token),
      };
      const updated = new Map(states);
      if (
        next.holder === undefined &&
        next.waiting.length === 0 &&
        next.quarantined === undefined
      )
        updated.delete(key);
      else updated.set(key, next);
      return updated;
    });
  }
}
