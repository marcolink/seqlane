// @test-scope ./joint-admission.ts
// @test-scope ../session/session-lock.ts
// @test-scope ../workspace/workspace-lock.ts
import { describe, expect, it } from "vitest";
import { SessionLockRegistry } from "../session/session-lock.js";
import { WorkspaceLockRegistry } from "../workspace/workspace-lock.js";
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

function request(invocationId: string, creationOrdinal: number) {
  return {
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
  it("does not retain workspace admission while its session is unavailable", async () => {
    const sessionLocks = new SessionLockRegistry();
    const workspaceLocks = new WorkspaceLockRegistry();
    const admissions = new JointAdmissionRegistry(workspaceLocks, sessionLocks);
    const activeSession = await sessionLocks.acquire(session);
    const waiting = admissions.acquire(request("waiting", 0));

    const competingWorkspace = await workspaceLocks.acquire(
      workspace,
      "exclusive",
      undefined,
      0,
      "competing",
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
    const activeWorkspace = await workspaceLocks.acquire(
      workspace,
      "exclusive",
      undefined,
      0,
      "active",
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

  it("gives an earlier exclusive request priority over a later shared request", async () => {
    const sessionLocks = new SessionLockRegistry();
    const workspaceLocks = new WorkspaceLockRegistry();
    const admissions = new JointAdmissionRegistry(workspaceLocks, sessionLocks);
    const active = await workspaceLocks.acquire(
      workspace,
      "shared",
      undefined,
      0,
      "active",
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
