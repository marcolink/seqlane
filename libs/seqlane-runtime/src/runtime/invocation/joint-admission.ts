import type { WorkspacePolicy } from "@seqlane/core";
import type { ResolvedExecutorSession } from "../session/session-resolution.js";
import {
  type SessionLockLease,
  type SessionLockRegistry,
} from "../session/session-lock.js";
import type { WorkspaceLockLease } from "../workspace/workspace-lock.js";
import type { WorkspaceResource } from "../workspace/workspace-resource.js";
import type { WorkspaceLockRegistry } from "../workspace/workspace-lock.js";

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

interface WaitingAdmission {
  readonly request: JointAdmissionRequest;
  readonly resolve: (admission: JointAdmission) => void;
  readonly reject: (cause: unknown) => void;
  readonly cleanup: () => void;
}

function createAbortWaiter(signal: AbortSignal): {
  readonly promise: Promise<void>;
  readonly cleanup: () => void;
} {
  if (signal.aborted)
    return { promise: Promise.resolve(), cleanup: () => undefined };

  let onAbort!: () => void;
  const promise = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup: () => signal.removeEventListener("abort", onAbort),
  };
}

/**
 * Coordinates session and workspace admission without reserving either resource.
 * Queues are per workspace so an exclusive request has writer preference over
 * later shared requests for that workspace.
 */
export class JointAdmissionRegistry {
  readonly #waiting = new Map<string, WaitingAdmission[]>();
  readonly #processing = new Set<string>();

  constructor(
    private readonly workspaceLocks: WorkspaceLockRegistry,
    private readonly sessionLocks: SessionLockRegistry,
  ) {}

  acquire(request: JointAdmissionRequest): Promise<JointAdmission> {
    return new Promise((resolve, reject) => {
      if (request.signal.aborted) {
        reject(request.signal.reason ?? new Error("Joint admission cancelled"));
        return;
      }

      const waiting = this.#waiting.get(request.workspace.key) ?? [];
      const onAbort = (): void => {
        const index = waiting.indexOf(admission);
        if (index === -1) return;
        waiting.splice(index, 1);
        if (waiting.length === 0) {
          this.#waiting.delete(request.workspace.key);
        }
        admission.cleanup();
        reject(request.signal.reason ?? new Error("Joint admission cancelled"));
      };
      const admission: WaitingAdmission = {
        request,
        resolve,
        reject,
        cleanup: () => request.signal.removeEventListener("abort", onAbort),
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      waiting.push(admission);
      waiting.sort(
        (first, second) =>
          first.request.creationOrdinal - second.request.creationOrdinal,
      );
      this.#waiting.set(request.workspace.key, waiting);
      void this.#process(request.workspace.key);
    });
  }

  async #process(workspaceKey: string): Promise<void> {
    if (this.#processing.has(workspaceKey)) return;
    this.#processing.add(workspaceKey);
    try {
      while (true) {
        const waiting = this.#waiting.get(workspaceKey);
        const next = waiting?.[0];
        if (next === undefined) {
          this.#waiting.delete(workspaceKey);
          return;
        }

        const abortWaiter = createAbortWaiter(next.request.signal);
        try {
          const admission = this.#tryAcquire(next.request);
          if (admission === undefined) {
            await Promise.race([
              this.workspaceLocks.waitForChange(),
              this.sessionLocks.waitForChange(),
              abortWaiter.promise,
            ]);
            continue;
          }
          waiting?.shift();
          next.cleanup();
          next.resolve(admission);
        } catch (cause) {
          waiting?.shift();
          next.cleanup();
          next.reject(cause);
        } finally {
          abortWaiter.cleanup();
        }
      }
    } finally {
      this.#processing.delete(workspaceKey);
      if (this.#waiting.get(workspaceKey)?.length)
        void this.#process(workspaceKey);
    }
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
}
