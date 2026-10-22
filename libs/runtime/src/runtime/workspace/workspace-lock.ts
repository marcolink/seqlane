import { Effect, TxRef } from "effect";
import type { WorkspacePolicy } from "@seqlane/core";
import type { WorkspaceResource } from "./workspace-resource.js";
import {
  acquireTransactional,
  admissionSync,
  type AdmissionDecision,
} from "../invocation/transactional-admission.js";

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

export interface WorkspaceClaim {
  readonly token: symbol;
  readonly policy: WorkspaceAdmission;
  readonly creationOrdinal: number;
  readonly ownerId: string;
  readonly ownerAncestors: readonly string[];
}

export interface WorkspaceLockState {
  readonly holders: ReadonlyMap<symbol, WorkspaceClaim>;
  readonly quarantined?: QuarantinedWorkspaceError;
  readonly waiting: readonly WorkspaceClaim[];
}

export function workspaceAvailable(
  state: WorkspaceLockState | undefined,
  policy: WorkspaceAdmission,
  ownerId = "",
  ownerAncestors: readonly string[] = [],
): boolean {
  if (state?.quarantined !== undefined) throw state.quarantined;
  return [...(state?.holders.values() ?? [])].every(
    (holder) =>
      holder.ownerId === ownerId ||
      ownerAncestors.includes(holder.ownerId) ||
      holder.ownerAncestors.includes(ownerId) ||
      (policy === "shared" && holder.policy === "shared"),
  );
}

export function workspaceTurn(
  state: WorkspaceLockState | undefined,
  claim: WorkspaceClaim,
  waiting: readonly WorkspaceClaim[],
): boolean {
  const ancestorReservation = [...(state?.holders.values() ?? [])].some(
    (holder) => claim.ownerAncestors.includes(holder.ownerId),
  );
  const ownIndex = waiting.findIndex((waiter) => waiter.token === claim.token);
  return !waiting.some(
    (waiter, index) =>
      waiter.token !== claim.token &&
      (waiter.creationOrdinal < claim.creationOrdinal ||
        (waiter.creationOrdinal === claim.creationOrdinal &&
          ownIndex >= 0 &&
          index < ownIndex)) &&
      (claim.policy === "exclusive" || waiter.policy === "exclusive") &&
      (!ancestorReservation ||
        waiter.ownerAncestors.at(-1) === claim.ownerAncestors.at(-1)),
  );
}

export function blockingInvocationId(
  state: WorkspaceLockState | undefined,
): string | undefined {
  const holders = [...(state?.holders.values() ?? [])];
  return (holders.find((holder) => holder.policy === "exclusive") ?? holders[0])
    ?.ownerId;
}

/** Immutable ownership and demand; native transactions provide waiting and wakeup. */
export class WorkspaceLockRegistry {
  readonly state = TxRef.makeUnsafe<ReadonlyMap<string, WorkspaceLockState>>(
    new Map(),
  );
  #nextAnonymousInvocation = 0;

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
      const token = Symbol();
      const claim: WorkspaceClaim = {
        token,
        policy,
        creationOrdinal,
        ownerId:
          ownerId ??
          invocationId ??
          `anonymous:${this.#nextAnonymousInvocation++}`,
        ownerAncestors,
      };
      return acquireTransactional({
        signal,
        register: TxRef.update(this.state, (states) => {
          const state: WorkspaceLockState = states.get(resource.key) ?? {
            holders: new Map(),
            waiting: [],
          };
          return new Map(states).set(resource.key, {
            ...state,
            waiting: [...state.waiting, claim].sort(
              (a, b) => a.creationOrdinal - b.creationOrdinal,
            ),
          });
        }),
        attempt: Effect.gen({ self: this }, function* () {
          const state = (yield* TxRef.get(this.state)).get(resource.key);
          if (state?.quarantined !== undefined)
            return yield* Effect.fail(state.quarantined);
          if (
            !workspaceAvailable(state, policy, claim.ownerId, ownerAncestors) ||
            !workspaceTurn(state, claim, state?.waiting ?? [])
          ) {
            const blocking = blockingInvocationId(state);
            return {
              _tag: "Waiting",
              reason: `workspace:${blocking ?? ""}`,
              notify: () => onWaiting?.(blocking),
            } satisfies AdmissionDecision<WorkspaceLockLease>;
          }
          return {
            _tag: "Acquired",
            lease: yield* this.take(resource, claim),
          } satisfies AdmissionDecision<WorkspaceLockLease>;
        }),
        cleanup: (failed) => this.remove(resource.key, token, failed),
      });
    });
  }

  isAvailable(
    resource: WorkspaceResource,
    policy: WorkspaceAdmission,
    ownerId?: string,
    ownerAncestors: readonly string[] = [],
  ): boolean {
    return admissionSync(
      TxRef.get(this.state).pipe(
        Effect.map((states) =>
          workspaceAvailable(
            states.get(resource.key),
            policy,
            ownerId,
            ownerAncestors,
          ),
        ),
      ),
    );
  }

  /** Compose with all resource checks inside one joint transaction. */
  take(
    resource: WorkspaceResource,
    claim: WorkspaceClaim,
  ): Effect.Effect<WorkspaceLockLease> {
    return TxRef.update(this.state, (states) => {
      const state: WorkspaceLockState = states.get(resource.key) ?? {
        holders: new Map(),
        waiting: [],
      };
      return new Map(states).set(resource.key, {
        ...state,
        holders: new Map(state.holders).set(claim.token, claim),
      });
    }).pipe(
      Effect.as({
        release: () =>
          admissionSync(this.remove(resource.key, claim.token, true)),
      }),
    );
  }

  quarantine(resource: WorkspaceResource, cause: unknown): void {
    admissionSync(
      TxRef.update(this.state, (states) => {
        const state: WorkspaceLockState = states.get(resource.key) ?? {
          holders: new Map(),
          waiting: [],
        };
        return state.quarantined === undefined
          ? new Map(states).set(resource.key, {
              ...state,
              quarantined: new QuarantinedWorkspaceError(cause),
            })
          : states;
      }),
    );
  }

  remove(key: string, token: symbol, release: boolean): Effect.Effect<void> {
    return TxRef.update(this.state, (states) => {
      const state = states.get(key);
      if (state === undefined) return states;
      const holders = new Map(state.holders);
      if (release && state.quarantined === undefined) holders.delete(token);
      const next = {
        ...state,
        holders,
        waiting: state.waiting.filter((waiter) => waiter.token !== token),
      };
      const updated = new Map(states);
      if (
        next.holders.size === 0 &&
        next.waiting.length === 0 &&
        next.quarantined === undefined
      )
        updated.delete(key);
      else updated.set(key, next);
      return updated;
    });
  }
}
