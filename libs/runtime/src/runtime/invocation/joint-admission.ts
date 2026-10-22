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
  readonly workspaceLeases?: readonly WorkspaceLockLease[];
}

export interface JointAdmissionRequest {
  readonly signal: AbortSignal;
  readonly session: ResolvedExecutorSession | undefined;
  readonly workspace: WorkspaceResource;
  readonly workspaceResources?: readonly WorkspaceResource[];
  readonly workspacePolicy: WorkspacePolicy;
  readonly workspacePolicies?: ReadonlyMap<string, WorkspacePolicy>;
  readonly invocationId: string;
  readonly ownerId?: string;
  readonly ownerAncestors?: readonly string[];
  readonly creationOrdinal: number;
  readonly onWorkspaceWaiting: (
    blockingInvocationId: string | undefined,
  ) => void;
  readonly onSessionWaiting: () => void;
}

function policyFor(
  request: JointAdmissionRequest,
  resource: WorkspaceResource,
): WorkspacePolicy {
  return (
    request.workspacePolicies?.get(resource.key) ??
    resource.requiredPolicy ??
    request.workspacePolicy
  );
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
          request.signal.aborted
            ? request.signal.reason
            : new Error("Joint admission cancelled"),
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
    const { session } = request;
    const workspaces = [...(request.workspaceResources ?? [request.workspace])];
    for (const workspace of workspaces) {
      const policy = policyFor(request, workspace);
      if (
        !this.workspaceLocks.isAvailable(
          workspace,
          policy,
          request.ownerId,
          request.ownerAncestors,
        )
      ) {
        request.onWorkspaceWaiting(
          this.workspaceLocks.blockingInvocationId(workspace),
        );
        return undefined;
      }
    }
    if (session !== undefined && !this.sessionLocks.isAvailable(session)) {
      request.onSessionWaiting();
      return undefined;
    }

    // JavaScript cannot interleave synchronous lock creation, so after both
    // availability checks these two leases are acquired as one admission.
    const workspaceLeases: WorkspaceLockLease[] = [];
    for (const workspace of workspaces) {
      const policy = policyFor(request, workspace);
      const lease = this.workspaceLocks.tryAcquire(
        workspace,
        policy,
        request.onWorkspaceWaiting,
        request.invocationId,
        request.ownerId,
        request.ownerAncestors,
      );
      if (lease === undefined) {
        for (const acquired of workspaceLeases) acquired.release();
        return undefined;
      }
      workspaceLeases.push(lease);
    }
    const sessionLease =
      session === undefined
        ? undefined
        : this.sessionLocks.tryAcquire(session, request.onSessionWaiting);
    if (session !== undefined && sessionLease === undefined) {
      throw new Error("Atomic admission became unavailable unexpectedly");
    }
    const workspaceLease = workspaceLeases[0];
    if (workspaceLease === undefined) {
      for (const acquired of workspaceLeases) acquired.release();
      throw new Error("Joint admission requires at least one workspace");
    }
    return { workspaceLease, workspaceLeases, sessionLease };
  }

  #acquireEffectLoop(
    waiter: EffectWaitingAdmission,
  ): Effect.Effect<JointAdmission, unknown> {
    return Effect.suspend(() => {
      if (waiter.request.signal.aborted)
        return Effect.fail(
          waiter.request.signal.aborted
            ? waiter.request.signal.reason
            : new Error("Joint admission cancelled"),
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
    const workspaces = [...(request.workspaceResources ?? [request.workspace])];
    for (const workspace of workspaces) {
      const policy = policyFor(request, workspace);
      const workspaceWaiters = this.#effectWaiting
        .filter(
          (entry) =>
            entry !== waiter &&
            this.#canWaiterReserveWorkspace(entry, workspace.key),
        )
        .map((entry) => ({
          policy: policyFor(entry.request, workspace),
          creationOrdinal: entry.request.creationOrdinal,
          ownerAncestors: entry.request.ownerAncestors,
        }));
      if (
        !this.workspaceLocks.canEffectWaiterProceed(
          workspace,
          policy,
          request.creationOrdinal,
          request.ownerAncestors ?? [],
          workspaceWaiters,
        )
      ) {
        request.onWorkspaceWaiting(
          this.workspaceLocks.blockingInvocationId(workspace),
        );
        return undefined;
      }
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
    const workspaces = [...(request.workspaceResources ?? [request.workspace])];
    try {
      return workspaces.every((workspace) => {
        const waiters = this.#effectWaiting
          .filter(
            (entry) =>
              entry !== waiter &&
              this.#canWaiterReserveWorkspace(entry, workspace.key),
          )
          .map((entry) => ({
            policy: policyFor(entry.request, workspace),
            creationOrdinal: entry.request.creationOrdinal,
            ownerAncestors: entry.request.ownerAncestors,
          }));
        return (
          this.workspaceLocks.canEffectWaiterProceed(
            workspace,
            policyFor(request, workspace),
            request.creationOrdinal,
            request.ownerAncestors ?? [],
            waiters,
          ) &&
          this.workspaceLocks.isAvailable(
            workspace,
            policyFor(request, workspace),
            request.ownerId,
            request.ownerAncestors,
          )
        );
      });
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

  /** A blocked group cannot reserve one of its otherwise-eligible resources. */
  #canWaiterReserveWorkspace(
    waiter: EffectWaitingAdmission,
    targetKey: string,
  ): boolean {
    const { request } = waiter;
    const workspaces = request.workspaceResources ?? [request.workspace];
    if (!workspaces.some((workspace) => workspace.key === targetKey))
      return false;
    if (
      request.session !== undefined &&
      !this.sessionLocks.isAvailable(request.session)
    )
      return false;
    try {
      return workspaces.every(
        (workspace) =>
          workspace.key === targetKey ||
          this.workspaceLocks.isAvailable(
            workspace,
            policyFor(request, workspace),
            request.ownerId,
            request.ownerAncestors,
          ),
      );
    } catch {
      // Do not let an unrelated quarantine make this waiter reserve another
      // resource while the group itself cannot be admitted.
      return false;
    }
  }

  #notifyEffectWaiters(): void {
    const waiters = [...this.#effectChangeWaiters];
    this.#effectChangeWaiters.clear();
    for (const waiter of waiters) {
      Deferred.doneUnsafe(waiter, Effect.void);
    }
  }
}
