// @test-scope ./joint-admission.ts
// @test-scope ../session/session-lock.ts
// @test-scope ../workspace/workspace-lock.ts
import { describe, expect, it } from "vitest";
import { Effect, Fiber } from "effect";
import { SessionLockRegistry } from "../session/session-lock.js";
import {
  QuarantinedWorkspaceError,
  WorkspaceLockRegistry,
} from "../workspace/workspace-lock.js";
import { JointAdmissionRegistry } from "./joint-admission.js";

const workspace = { key: "/checkout" };
const session = {
  key: Symbol("session"),
  executor: { execute: async () => ({}) },
};

async function expectPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
}

function request(
  invocationId: string,
  creationOrdinal: number,
  signal = new AbortController().signal,
) {
  return {
    signal,
    session,
    workspace,
    workspacePolicy: "exclusive" as const,
    invocationId,
    creationOrdinal,
    onWorkspaceWaiting: () => undefined,
    onSessionWaiting: () => undefined,
  };
}

describe("joint admission", () => {
  it("removes a fiber-interrupted waiter without retaining workspace eligibility", async () => {
    const sessionLocks = new SessionLockRegistry();
    const workspaceLocks = new WorkspaceLockRegistry();
    const admissions = new JointAdmissionRegistry(workspaceLocks, sessionLocks);
    const active = await Effect.runPromise(
      workspaceLocks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        0,
        "active",
      ),
    );
    let notifyWaiting!: () => void;
    const waitingSignal = new Promise<void>((resolve) => {
      notifyWaiting = resolve;
    });
    const waiting = request("interrupted", 1);
    const fiber = Effect.runFork(
      admissions.acquireEffect({
        ...waiting,
        onWorkspaceWaiting: () => notifyWaiting(),
      }),
    );

    await waitingSignal;
    await Effect.runPromise(Fiber.interrupt(fiber));
    active.release();

    const next = await admissions.acquire(request("next", 2));
    next.sessionLease?.release();
    next.workspaceLease.release();
  });

  it("removes an aborted waiter before the current owner releases", async () => {
    const sessionLocks = new SessionLockRegistry();
    const workspaceLocks = new WorkspaceLockRegistry();
    const admissions = new JointAdmissionRegistry(workspaceLocks, sessionLocks);
    const active = await Effect.runPromise(
      workspaceLocks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        0,
        "active",
      ),
    );
    const controller = new AbortController();
    const reason = new Error("cancelled before owner release");
    let notifyWaiting!: () => void;
    const waitingSignal = new Promise<void>((resolve) => {
      notifyWaiting = resolve;
    });
    const cancelled = admissions.acquireEffect({
      ...request("cancelled", 1, controller.signal),
      onWorkspaceWaiting: () => notifyWaiting(),
    });
    const result = Effect.runPromise(cancelled);

    await waitingSignal;
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    active.release();
    const next = await admissions.acquire(request("next", 2));
    next.sessionLease?.release();
    next.workspaceLease.release();
  });

  it("does not retain workspace admission while its session is unavailable", async () => {
    const sessionLocks = new SessionLockRegistry();
    const workspaceLocks = new WorkspaceLockRegistry();
    const admissions = new JointAdmissionRegistry(workspaceLocks, sessionLocks);
    const activeSession = await sessionLocks.acquire(session);
    const waiting = admissions.acquire(request("waiting", 0));

    const competingWorkspace = await Effect.runPromise(
      workspaceLocks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        0,
        "competing",
      ),
    );
    expect(competingWorkspace).toBeDefined();

    competingWorkspace.release();
    activeSession.release();
    const admission = await waiting;
    admission.sessionLease?.release();
    admission.workspaceLease.release();
  });

  it("does not retain session admission while its workspace is unavailable", async () => {
    const sessionLocks = new SessionLockRegistry();
    const workspaceLocks = new WorkspaceLockRegistry();
    const admissions = new JointAdmissionRegistry(workspaceLocks, sessionLocks);
    const activeWorkspace = await Effect.runPromise(
      workspaceLocks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        0,
        "active",
      ),
    );
    const waiting = admissions.acquire(request("waiting", 0));

    const competingSession = await sessionLocks.acquire(session);
    expect(competingSession).toBeDefined();

    competingSession.release();
    activeWorkspace.release();
    const admission = await waiting;
    admission.sessionLease?.release();
    admission.workspaceLease.release();
  });

  it("does not virtually reserve an available resource while a group waits on another", async () => {
    const sessionLocks = new SessionLockRegistry();
    const workspaceLocks = new WorkspaceLockRegistry();
    const admissions = new JointAdmissionRegistry(workspaceLocks, sessionLocks);
    const first = { key: "/first" };
    const second = { key: "/second" };
    const activeSecond = await Effect.runPromise(
      workspaceLocks.acquireEffect(second, "exclusive"),
    );
    let groupWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      groupWaiting = resolve;
    });
    const grouped = admissions.acquireEffect({
      ...request("group", 1),
      session: undefined,
      workspace: first,
      workspaceResources: [first, second],
      onWorkspaceWaiting: () => groupWaiting(),
    });
    const groupPromise = Effect.runPromise(grouped);

    await waiting;
    const independent = await admissions.acquire({
      ...request("independent", 2),
      workspace: first,
    });
    independent.sessionLease?.release();
    for (const lease of independent.workspaceLeases ?? [
      independent.workspaceLease,
    ])
      lease.release();

    activeSecond.release();
    const groupAdmission = await groupPromise;
    groupAdmission.sessionLease?.release();
    for (const lease of groupAdmission.workspaceLeases ?? [
      groupAdmission.workspaceLease,
    ])
      lease.release();
  });

  it("cancels a waiting resource group without retaining any partial lease", async () => {
    const sessionLocks = new SessionLockRegistry();
    const workspaceLocks = new WorkspaceLockRegistry();
    const admissions = new JointAdmissionRegistry(workspaceLocks, sessionLocks);
    const first = { key: "/first" };
    const second = { key: "/second" };
    const activeSecond = await Effect.runPromise(
      workspaceLocks.acquireEffect(second, "exclusive"),
    );
    const controller = new AbortController();
    let groupWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      groupWaiting = resolve;
    });
    const grouped = Effect.runPromise(
      admissions.acquireEffect({
        ...request("cancelled-group", 1, controller.signal),
        session: undefined,
        workspace: first,
        workspaceResources: [first, second],
        onWorkspaceWaiting: () => groupWaiting(),
      }),
    );
    await waiting;
    const reason = new Error("cancel grouped admission");
    controller.abort(reason);
    await expect(grouped).rejects.toBe(reason);

    const independent = await admissions.acquire({
      ...request("independent", 2),
      workspace: first,
    });
    independent.sessionLease?.release();
    for (const lease of independent.workspaceLeases ?? [
      independent.workspaceLease,
    ])
      lease.release();
    activeSecond.release();
  });

  it("lets an eligible same-session waiter proceed past an earlier blocked workspace", async () => {
    const sessionLocks = new SessionLockRegistry();
    const workspaceLocks = new WorkspaceLockRegistry();
    const admissions = new JointAdmissionRegistry(workspaceLocks, sessionLocks);
    const blockedWorkspace = { key: "/blocked-checkout" };
    const availableWorkspace = { key: "/available-checkout" };
    const activeWorkspace = await Effect.runPromise(
      workspaceLocks.acquireEffect(
        blockedWorkspace,
        "exclusive",
        undefined,
        0,
        "active",
      ),
    );
    let blockedWaiterObserved!: () => void;
    const blockedWaiter = new Promise<void>((resolve) => {
      blockedWaiterObserved = resolve;
    });
    const blocked = admissions.acquire({
      ...request("blocked", 1),
      workspace: blockedWorkspace,
      onWorkspaceWaiting: () => blockedWaiterObserved(),
    });
    await blockedWaiter;

    const independent = await admissions.acquire({
      ...request("independent", 2),
      workspace: availableWorkspace,
    });
    independent.sessionLease?.release();
    independent.workspaceLease.release();
    activeWorkspace.release();
    const first = await blocked;
    first.sessionLease?.release();
    first.workspaceLease.release();
  });

  it("fails a quarantined earlier workspace waiter without poisoning another workspace", async () => {
    const sessionLocks = new SessionLockRegistry();
    const workspaceLocks = new WorkspaceLockRegistry();
    const admissions = new JointAdmissionRegistry(workspaceLocks, sessionLocks);
    const blockedWorkspace = { key: "/quarantined-checkout" };
    const availableWorkspace = { key: "/unrelated-checkout" };
    const activeWorkspace = await Effect.runPromise(
      workspaceLocks.acquireEffect(
        blockedWorkspace,
        "exclusive",
        undefined,
        0,
        "workspace-owner",
      ),
    );
    const activeSession = await sessionLocks.acquire(session);
    let blockedWaiterObserved!: () => void;
    const blockedWaiter = new Promise<void>((resolve) => {
      blockedWaiterObserved = resolve;
    });
    const blocked = admissions.acquire({
      ...request("blocked", 1),
      workspace: blockedWorkspace,
      onWorkspaceWaiting: () => blockedWaiterObserved(),
    });
    await blockedWaiter;
    let independentWaiterObserved!: () => void;
    const independentWaiter = new Promise<void>((resolve) => {
      independentWaiterObserved = resolve;
    });
    const independent = admissions.acquire({
      ...request("independent", 2),
      workspace: availableWorkspace,
      onSessionWaiting: () => independentWaiterObserved(),
    });
    await independentWaiter;

    const quarantine = new QuarantinedWorkspaceError(new Error("uncertain"));
    workspaceLocks.quarantine(blockedWorkspace, quarantine);
    activeSession.release();
    activeWorkspace.release();
    await expect(blocked).rejects.toBeInstanceOf(QuarantinedWorkspaceError);
    const admission = await independent;
    admission.sessionLease?.release();
    admission.workspaceLease.release();
  });

  it("gives an earlier exclusive request priority over a later shared request", async () => {
    const sessionLocks = new SessionLockRegistry();
    const workspaceLocks = new WorkspaceLockRegistry();
    const admissions = new JointAdmissionRegistry(workspaceLocks, sessionLocks);
    const active = await Effect.runPromise(
      workspaceLocks.acquireEffect(workspace, "shared", undefined, 0, "active"),
    );
    const exclusive = admissions.acquire(request("exclusive", 1));
    const shared = admissions.acquire({
      ...request("shared", 2),
      workspacePolicy: "shared",
    });

    await expectPending(exclusive);
    await expectPending(shared);
    active.release();
    const first = await exclusive;
    await expectPending(shared);
    first.sessionLease?.release();
    first.workspaceLease.release();
    const second = await shared;
    second.sessionLease?.release();
    second.workspaceLease.release();
  });
});
