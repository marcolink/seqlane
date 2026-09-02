import { describe, expect, it } from "vitest";
import type { WorkspaceResource } from "./workspace-resource.js";
import { WorkspaceLockRegistry } from "./workspace-lock.js";

const workspace: WorkspaceResource = { key: "/checkout" };

async function expectPending(promise: Promise<unknown>) {
  await expect(
    Promise.race([
      promise.then(() => "acquired"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]),
  ).resolves.toBe("pending");
}

describe("workspace policy locks", () => {
  it("grants exclusive admission for an idle workspace", async () => {
    const locks = new WorkspaceLockRegistry();

    const lease = await locks.acquire(workspace, "exclusive");

    lease.release();
  });

  it("shares shared admission while an exclusive task waits", async () => {
    const locks = new WorkspaceLockRegistry();
    const firstReader = await locks.acquire(workspace, "shared");

    const secondReader = await locks.acquire(workspace, "shared");
    const waitingWriter = locks.acquire(workspace, "exclusive");

    await expectPending(waitingWriter);

    secondReader.release();
    await expectPending(waitingWriter);

    firstReader.release();
    const writer = await waitingWriter;

    writer.release();
  });

  it("does not let a late shared request bypass queued exclusive admission", async () => {
    const locks = new WorkspaceLockRegistry();
    const activeShared = await locks.acquire(workspace, "shared");
    const waitingExclusive = locks.acquire(workspace, "exclusive");
    const lateShared = locks.acquire(workspace, "shared");

    await expectPending(waitingExclusive);
    await expectPending(lateShared);

    activeShared.release();
    const exclusive = await waitingExclusive;

    await expectPending(lateShared);

    exclusive.release();
    (await lateShared).release();
  });

  it("blocks shared and exclusive admission until exclusive release", async () => {
    const locks = new WorkspaceLockRegistry();
    const writer = await locks.acquire(workspace, "exclusive");
    const waitingReader = locks.acquire(workspace, "shared");
    const waitingWriter = locks.acquire(workspace, "exclusive");

    await expectPending(waitingReader);
    await expectPending(waitingWriter);

    writer.release();
    const reader = await waitingReader;

    await expectPending(waitingWriter);

    reader.release();
    const nextWriter = await waitingWriter;

    nextWriter.release();
  });

  it("grants waiting exclusive tasks in invocation creation order", async () => {
    const locks = new WorkspaceLockRegistry();
    const activeWriter = await locks.acquire(workspace, "exclusive");
    const laterWriter = locks.acquire(workspace, "exclusive", undefined, 2);
    const earlierWriter = locks.acquire(workspace, "exclusive", undefined, 1);

    activeWriter.release();
    const firstAdmitted = await Promise.race([
      earlierWriter.then((lease) => ({ invocation: "earlier", lease })),
      laterWriter.then((lease) => ({ invocation: "later", lease })),
    ]);

    expect(firstAdmitted.invocation).toBe("earlier");
    firstAdmitted.lease.release();
    (await laterWriter).release();
  });
});
