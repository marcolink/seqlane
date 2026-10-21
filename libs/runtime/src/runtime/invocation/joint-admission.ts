import { Deferred, Effect } from "effect";
import type { WorkspacePolicy } from "@seqlane/core";
import type { ResolvedExecutorSession } from "../session/session-resolution.js";
import {
  type SessionLockLease,
  type SessionLockRegistry,
} from "../session/session-lock.js";
import type { WorkspaceLockLease } from "../workspace/workspace-lock.js";
import type { WorkspaceResource } from "../workspace/workspace-resource.js";
import type { WorkspaceLockRegistry } from "../workspace/workspace-lock.js";
import { QuarantinedWorkspaceError } from "../workspace/workspace-lock.js";
import { awaitAbort } from "../execution/await-abort.js";

export interface JointAdmission {
  readonly sessionLease: SessionLockLease | undefined;
  readonly workspaceLease: WorkspaceLockLease;
}

export interface JointAdmissionRequest {
  readonly signal: AbortSignal;
  readonly session: ResolvedExecutorSession | undefined;
  readonly workspace: WorkspaceResource;
  readonly workspacePolicy: WorkspacePolicy;
  readonly invocationId: string;
  readonly ownerId?: string;
  readonly creationOrdinal: number;
  readonly onWorkspaceWaiting: (
    blockingInvocationId: string | undefined,
  ) => void;
  readonly onSessionWaiting: () => void;
}

interface EffectWaitingAdmission {
  readonly request: JointAdmissionRequest;
}

/**
 * Coordinates session and workspace admission without reserving either resource.
 * Queues are per workspace so an exclusive request has writer preference over
 * later shared requests for that workspace.
 */
export class JointAdmissionRegistry {
  readonly #effectWaiting: EffectWaitingAdmission[] = [];
  readonly #effectChangeWaiters = new Set<Deferred.Deferred<void>>();

  constructor(
    private readonly workspaceLocks: WorkspaceLockRegistry,
    private readonly sessionLocks: SessionLockRegistry,
  ) {
    workspaceLocks.onChange(() => this.#notifyEffectWaiters());
    sessionLocks.onChange(() => this.#notifyEffectWaiters());
  }

  /**
   * Acquire both resources from the caller's Effect scope. Waiters never hold
   * one resource while they wait for the other.
   */
  acquireEffect(
    request: JointAdmissionRequest,
  ): Effect.Effect<JointAdmission, unknown> {
    return Effect.suspend(() => {
      if (request.signal.aborted)
        return Effect.fail(
          request.signal.reason ?? new Error("Joint admission cancelled"),
        );
      const waiter: EffectWaitingAdmission = { request };
      this.#effectWaiting.push(waiter);
      this.#effectWaiting.sort(
        (first, second) =>
          first.request.creationOrdinal - second.request.creationOrdinal,
      );
      this.#notifyEffectWaiters();
      return Effect.onExit(this.#acquireEffectLoop(waiter), () =>
        Effect.sync(() => this.#removeEffectWaiter(waiter)),
      );
    });
  }

  acquire(request: JointAdmissionRequest): Promise<JointAdmission> {
    return Effect.runPromise(this.acquireEffect(request));
  }

  #tryAcquire(request: JointAdmissionRequest): JointAdmission | undefined {
    const { session, workspace, workspacePolicy } = request;
    if (
      !this.workspaceLocks.isAvailable(
        workspace,
        workspacePolicy,
        request.ownerId,
      )
    ) {
      request.onWorkspaceWaiting(
        this.workspaceLocks.blockingInvocationId(workspace),
      );
      return undefined;
    }
    if (session !== undefined && !this.sessionLocks.isAvailable(session)) {
      request.onSessionWaiting();
      return undefined;
    }

    // JavaScript cannot interleave synchronous lock creation, so after both
    // availability checks these two leases are acquired as one admission.
    const workspaceLease = this.workspaceLocks.tryAcquire(
      workspace,
      workspacePolicy,
      request.onWorkspaceWaiting,
      request.invocationId,
      request.ownerId,
    );
    const sessionLease =
      session === undefined
        ? undefined
        : this.sessionLocks.tryAcquire(session, request.onSessionWaiting);
    if (
      workspaceLease === undefined ||
      (session !== undefined && sessionLease === undefined)
    ) {
      throw new Error("Atomic admission became unavailable unexpectedly");
    }
    return { workspaceLease, sessionLease };
  }

  #acquireEffectLoop(
    waiter: EffectWaitingAdmission,
  ): Effect.Effect<JointAdmission, unknown> {
    return Effect.suspend(() => {
      if (waiter.request.signal.aborted)
        return Effect.fail(
          waiter.request.signal.reason ??
            new Error("Joint admission cancelled"),
        );
      // Register before the checks. A release between the checks and wait is
      // then retained by the Deferred and cannot become a lost wakeup.
      const changed = Deferred.makeUnsafe<void>();
      this.#effectChangeWaiters.add(changed);
      let admission: JointAdmission | undefined;
      try {
        admission = this.#tryAcquireEffect(waiter);
      } catch (cause) {
        this.#effectChangeWaiters.delete(changed);
        return Effect.fail(cause);
      }
      if (admission !== undefined) {
        this.#effectChangeWaiters.delete(changed);
        this.#removeEffectWaiter(waiter);
        this.#notifyEffectWaiters();
        return Effect.succeed(admission);
      }
      const wait = Effect.raceFirst(
        Deferred.await(changed),
        awaitAbort(waiter.request.signal, "Joint admission cancelled"),
      );
      return Effect.onExit(wait, () =>
        Effect.sync(() => this.#effectChangeWaiters.delete(changed)),
      ).pipe(Effect.andThen(this.#acquireEffectLoop(waiter)));
    });
  }

  #tryAcquireEffect(
    waiter: EffectWaitingAdmission,
  ): JointAdmission | undefined {
    const { request } = waiter;
    const workspaceWaiters = this.#effectWaiting
      .filter((entry) => entry.request.workspace.key === request.workspace.key)
      .map((entry) => ({
        policy: entry.request.workspacePolicy,
        creationOrdinal: entry.request.creationOrdinal,
      }));
    if (
      !this.workspaceLocks.canEffectWaiterProceed(
        request.workspace,
        request.workspacePolicy,
        request.creationOrdinal,
        request.ownerId,
        workspaceWaiters,
      )
    ) {
      request.onWorkspaceWaiting(
        this.workspaceLocks.blockingInvocationId(request.workspace),
      );
      return undefined;
    }
    if (request.session !== undefined) {
      const earlierSessionWaiter = this.#effectWaiting.some(
        (entry) =>
          entry !== waiter &&
          entry.request.session?.key === request.session?.key &&
          entry.request.creationOrdinal < request.creationOrdinal &&
          this.#hasWorkspaceTurn(entry),
      );
      if (
        earlierSessionWaiter ||
        !this.sessionLocks.hasEffectWaiterTurn(
          request.session,
          request.creationOrdinal,
        )
      ) {
        request.onSessionWaiting();
        return undefined;
      }
    }
    return this.#tryAcquire(request);
  }

  #hasWorkspaceTurn(waiter: EffectWaitingAdmission): boolean {
    const { request } = waiter;
    const workspaceWaiters = this.#effectWaiting
      .filter((entry) => entry.request.workspace.key === request.workspace.key)
      .map((entry) => ({
        policy: entry.request.workspacePolicy,
        creationOrdinal: entry.request.creationOrdinal,
      }));
    try {
      return (
        this.workspaceLocks.canEffectWaiterProceed(
          request.workspace,
          request.workspacePolicy,
          request.creationOrdinal,
          request.ownerId,
          workspaceWaiters,
        ) &&
        this.workspaceLocks.isAvailable(
          request.workspace,
          request.workspacePolicy,
          request.ownerId,
        )
      );
    } catch (cause) {
      // A quarantined workspace fails its own waiter when it next runs. It must
      // not reserve a shared session while an unrelated workspace can proceed.
      if (cause instanceof QuarantinedWorkspaceError) return false;
      throw cause;
    }
  }

  #removeEffectWaiter(waiter: EffectWaitingAdmission): void {
    const index = this.#effectWaiting.indexOf(waiter);
    if (index === -1) return;
    this.#effectWaiting.splice(index, 1);
    this.#notifyEffectWaiters();
  }

  #notifyEffectWaiters(): void {
    const waiters = [...this.#effectChangeWaiters];
    this.#effectChangeWaiters.clear();
    for (const waiter of waiters) {
      Deferred.doneUnsafe(waiter, Effect.void);
    }
  }
}
