import { Effect, TxRef } from "effect";
import type {
  SessionLockLease,
  SessionLockRegistry,
} from "../session/session-lock.js";
import type {
  WorkspaceLockLease,
  WorkspaceLockRegistry,
} from "../workspace/workspace-lock.js";
import {
  claimFor,
  eligibility,
  resources,
  type AdmissionSnapshot,
  type JointAdmissionRequest,
  type WaitingAdmission,
} from "./joint-admission-policy.js";
import {
  acquireTransactional,
  type AdmissionDecision,
} from "./transactional-admission.js";

export type { JointAdmissionRequest } from "./joint-admission-policy.js";

export interface JointAdmission {
  readonly sessionLease: SessionLockLease | undefined;
  readonly workspaceLease: WorkspaceLockLease;
  readonly workspaceLeases?: readonly WorkspaceLockLease[];
}

/** One transaction owns session, every workspace, and creation-ordered demand. */
export class JointAdmissionRegistry {
  readonly #waiting = TxRef.makeUnsafe<readonly WaitingAdmission[]>([]);

  constructor(
    private readonly workspaceLocks: WorkspaceLockRegistry,
    private readonly sessionLocks: SessionLockRegistry,
  ) {}

  acquireEffect(
    request: JointAdmissionRequest,
  ): Effect.Effect<JointAdmission, unknown> {
    return Effect.suspend(() => {
      if (request.signal.aborted) return Effect.fail(request.signal.reason);
      if (resources(request).length === 0)
        return Effect.fail(
          new Error("Joint admission requires at least one workspace"),
        );
      const waiter: WaitingAdmission = { token: Symbol(), request };
      return acquireTransactional({
        signal: request.signal,
        register: TxRef.update(this.#waiting, (waiting) =>
          [...waiting, waiter].sort(
            (a, b) => a.request.creationOrdinal - b.request.creationOrdinal,
          ),
        ),
        attempt: this.#attempt(waiter),
        cleanup: (failed) => this.#cleanup(waiter, failed),
      });
    });
  }

  #attempt(
    waiter: WaitingAdmission,
  ): Effect.Effect<AdmissionDecision<JointAdmission>, unknown> {
    const { request } = waiter;
    return Effect.gen({ self: this }, function* () {
      const snapshot: AdmissionSnapshot = {
        sessions: yield* TxRef.get(this.sessionLocks.state),
        workspaces: yield* TxRef.get(this.workspaceLocks.state),
        waiting: yield* TxRef.get(this.#waiting),
      };
      const decision = yield* Effect.try({
        try: () => eligibility(snapshot, waiter),
        catch: (cause) => cause,
      });
      if (decision._tag === "Waiting") return decision;
      const workspaceLeases: WorkspaceLockLease[] = [];
      for (const workspace of resources(request))
        workspaceLeases.push(
          yield* this.workspaceLocks.take(
            workspace,
            claimFor(waiter, workspace),
          ),
        );
      const sessionLease =
        request.session === undefined
          ? undefined
          : yield* this.sessionLocks.take(request.session, waiter.token);
      const workspaceLease = workspaceLeases[0];
      if (workspaceLease === undefined)
        return yield* Effect.fail(
          new Error("Joint admission requires at least one workspace"),
        );
      yield* TxRef.update(this.#waiting, (waiting) =>
        waiting.filter((entry) => entry !== waiter),
      );
      return {
        _tag: "Acquired",
        lease: { sessionLease, workspaceLease, workspaceLeases },
      } satisfies AdmissionDecision<JointAdmission>;
    });
  }

  #cleanup(waiter: WaitingAdmission, failed: boolean): Effect.Effect<void> {
    const { request } = waiter;
    return Effect.tx(
      Effect.gen({ self: this }, function* () {
        yield* TxRef.update(this.#waiting, (waiting) =>
          waiting.filter((entry) => entry !== waiter),
        );
        if (!failed) return;
        for (const workspace of resources(request))
          yield* this.workspaceLocks.remove(workspace.key, waiter.token, true);
        if (request.session !== undefined)
          yield* this.sessionLocks.remove(
            request.session.key,
            waiter.token,
            true,
          );
      }),
    );
  }

  /** Promise task callbacks enter admission only at their owned integration edge. */
  acquire(request: JointAdmissionRequest): Promise<JointAdmission> {
    return Effect.runPromise(this.acquireEffect(request));
  }
}
