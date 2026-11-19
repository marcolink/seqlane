import type { WorkspacePolicy } from "@seqlane/core";
import type { ResolvedExecutorSession } from "../session/session-resolution.js";
import {
  sessionAvailable,
  type SessionLockState,
} from "../session/session-lock.js";
import {
  blockingInvocationId,
  workspaceAvailable,
  workspaceTurn,
  type WorkspaceClaim,
  type WorkspaceLockState,
} from "../workspace/workspace-lock.js";
import type { WorkspaceResource } from "../workspace/workspace-resource.js";
import type { AdmissionDecision } from "./transactional-admission.js";

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

export interface WaitingAdmission {
  readonly token: symbol;
  readonly request: JointAdmissionRequest;
}

export interface AdmissionSnapshot {
  readonly sessions: ReadonlyMap<symbol, SessionLockState>;
  readonly workspaces: ReadonlyMap<string, WorkspaceLockState>;
  readonly waiting: readonly WaitingAdmission[];
}

export function resources(
  request: JointAdmissionRequest,
): readonly WorkspaceResource[] {
  return request.workspaceResources ?? [request.workspace];
}

export function claimFor(
  waiter: WaitingAdmission,
  workspace: WorkspaceResource,
): WorkspaceClaim {
  const { request, token } = waiter;
  return {
    token,
    policy: policyFor(request, workspace),
    creationOrdinal: request.creationOrdinal,
    ownerId: request.ownerId ?? request.invocationId,
    ownerAncestors: request.ownerAncestors ?? [],
  };
}

/** A group blocked elsewhere cannot reserve this otherwise available workspace. */
function canReserveWorkspace(
  snapshot: AdmissionSnapshot,
  waiter: WaitingAdmission,
  targetKey: string,
): boolean {
  const { request } = waiter;
  if (!resources(request).some((workspace) => workspace.key === targetKey))
    return false;
  const session =
    request.session === undefined
      ? undefined
      : snapshot.sessions.get(request.session.key);
  if (
    session?.quarantined !== undefined ||
    (request.session !== undefined && !sessionAvailable(session))
  )
    return false;
  return resources(request).every((workspace) => {
    const state = snapshot.workspaces.get(workspace.key);
    return (
      state?.quarantined === undefined &&
      (workspace.key === targetKey ||
        workspaceAvailable(
          state,
          policyFor(request, workspace),
          request.ownerId ?? request.invocationId,
          request.ownerAncestors,
        ))
    );
  });
}

function hasWorkspaceTurn(
  snapshot: AdmissionSnapshot,
  waiter: WaitingAdmission,
): boolean {
  return resources(waiter.request).every((workspace) => {
    const state = snapshot.workspaces.get(workspace.key);
    const claim = claimFor(waiter, workspace);
    return (
      state?.quarantined === undefined &&
      workspaceAvailable(
        state,
        claim.policy,
        claim.ownerId,
        claim.ownerAncestors,
      ) &&
      workspaceTurn(state, claim, workspaceWaiters(snapshot, workspace))
    );
  });
}

function workspaceWaiters(
  snapshot: AdmissionSnapshot,
  workspace: WorkspaceResource,
): readonly WorkspaceClaim[] {
  return [
    ...(snapshot.workspaces.get(workspace.key)?.waiting ?? []),
    ...snapshot.waiting
      .filter((waiter) => canReserveWorkspace(snapshot, waiter, workspace.key))
      .map((waiter) => claimFor(waiter, workspace)),
  ].sort((a, b) => a.creationOrdinal - b.creationOrdinal);
}

export function eligibility(
  snapshot: AdmissionSnapshot,
  waiter: WaitingAdmission,
): AdmissionDecision<void> {
  const { request } = waiter;
  for (const workspace of resources(request)) {
    const state = snapshot.workspaces.get(workspace.key);
    const claim = claimFor(waiter, workspace);
    if (
      !workspaceAvailable(
        state,
        claim.policy,
        claim.ownerId,
        claim.ownerAncestors,
      ) ||
      !workspaceTurn(state, claim, workspaceWaiters(snapshot, workspace))
    ) {
      const blocking = blockingInvocationId(state);
      return {
        _tag: "Waiting",
        reason: `workspace:${workspace.key}:${blocking ?? ""}`,
        notify: () => request.onWorkspaceWaiting(blocking),
      };
    }
  }
  if (request.session !== undefined) {
    const state = snapshot.sessions.get(request.session.key);
    const earlierSessionWaiter = snapshot.waiting.some(
      (entry) =>
        entry !== waiter &&
        entry.request.session?.key === request.session?.key &&
        entry.request.creationOrdinal < request.creationOrdinal &&
        hasWorkspaceTurn(snapshot, entry),
    );
    if (!sessionAvailable(state) || earlierSessionWaiter)
      return {
        _tag: "Waiting",
        reason: "session",
        notify: request.onSessionWaiting,
      };
  }
  return { _tag: "Acquired", lease: undefined };
}
