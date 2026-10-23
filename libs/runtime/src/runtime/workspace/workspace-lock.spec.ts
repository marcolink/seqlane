import { Effect } from "effect";
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

    const lease = await Effect.runPromise(
      locks.acquireEffect(workspace, "exclusive"),
    );

    lease.release();
  });

  it("allows a nested invocation to re-enter its parent workspace lease", async () => {
    const locks = new WorkspaceLockRegistry();
    const parent = await Effect.runPromise(
      locks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        0,
        "parent",
        "parent",
      ),
    );
    const child = await Effect.runPromise(
      locks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        1,
        "parent:child",
        "parent",
      ),
    );

    child.release();
    parent.release();
  });

  it("serializes sibling exclusive children while allowing each under its ancestor", async () => {
    const locks = new WorkspaceLockRegistry();
    const parent = await Effect.runPromise(
      locks.acquireEffect(workspace, "exclusive", undefined, 0, "parent"),
    );
    const first = await Effect.runPromise(
      locks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        1,
        "parent:first",
        undefined,
        ["parent"],
      ),
    );
    const second = Effect.runPromise(
      locks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        2,
        "parent:second",
        undefined,
        ["parent"],
      ),
    );

    await expectPending(second);
    first.release();
    (await second).release();
    parent.release();
  });

  it("lets a child bypass a foreign writer queued behind its parent reservation", async () => {
    const locks = new WorkspaceLockRegistry();
    const parent = await Effect.runPromise(
      locks.acquireEffect(workspace, "exclusive", undefined, 0, "parent"),
    );
    let foreignWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      foreignWaiting = resolve;
    });
    const foreign = Effect.runPromise(
      locks.acquireEffect(
        workspace,
        "exclusive",
        () => foreignWaiting(),
        1,
        "foreign",
      ),
    );
    await waiting;
    const child = await Effect.runPromise(
      locks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        2,
        "parent:child",
        undefined,
        ["parent"],
      ),
    );

    child.release();
    parent.release();
    (await foreign).release();
  });

  it("makes an exclusive child exclude foreign shared readers under a shared parent", async () => {
    const locks = new WorkspaceLockRegistry();
    const parent = await Effect.runPromise(
      locks.acquireEffect(workspace, "shared", undefined, 0, "parent"),
    );
    const child = await Effect.runPromise(
      locks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        1,
        "parent:child",
        undefined,
        ["parent"],
      ),
    );
    const foreignReader = Effect.runPromise(
      locks.acquireEffect(workspace, "shared", undefined, 2, "foreign-reader"),
    );

    await expectPending(foreignReader);
    child.release();
    parent.release();
    (await foreignReader).release();
  });

  it("allows two levels of nested exclusive ownership without merging sibling owners", async () => {
    const locks = new WorkspaceLockRegistry();
    const root = await Effect.runPromise(
      locks.acquireEffect(workspace, "exclusive", undefined, 0, "root"),
    );
    const child = await Effect.runPromise(
      locks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        1,
        "root:child",
        undefined,
        ["root"],
      ),
    );
    const grandchild = await Effect.runPromise(
      locks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        2,
        "root:child:grandchild",
        undefined,
        ["root", "root:child"],
      ),
    );
    const sibling = Effect.runPromise(
      locks.acquireEffect(
        workspace,
        "exclusive",
        undefined,
        3,
        "root:sibling",
        undefined,
        ["root"],
      ),
    );

    await expectPending(sibling);
    grandchild.release();
    child.release();
    (await sibling).release();
    root.release();
  });

  it("shares shared admission while an exclusive task waits", async () => {
    const locks = new WorkspaceLockRegistry();
    const firstReader = await Effect.runPromise(
      locks.acquireEffect(workspace, "shared"),
    );

    const secondReader = await Effect.runPromise(
      locks.acquireEffect(workspace, "shared"),
    );
    const waitingWriter = Effect.runPromise(
      locks.acquireEffect(workspace, "exclusive"),
    );

    await expectPending(waitingWriter);

    secondReader.release();
    await expectPending(waitingWriter);

    firstReader.release();
    const writer = await waitingWriter;

    writer.release();
  });

  it("does not let a late shared request bypass queued exclusive admission", async () => {
    const locks = new WorkspaceLockRegistry();
    const activeShared = await Effect.runPromise(
      locks.acquireEffect(workspace, "shared"),
    );
    const waitingExclusive = Effect.runPromise(
      locks.acquireEffect(workspace, "exclusive"),
    );
    const lateShared = Effect.runPromise(
      locks.acquireEffect(workspace, "shared"),
    );

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
    const writer = await Effect.runPromise(
      locks.acquireEffect(workspace, "exclusive"),
    );
    const waitingReader = Effect.runPromise(
      locks.acquireEffect(workspace, "shared"),
    );
    const waitingWriter = Effect.runPromise(
      locks.acquireEffect(workspace, "exclusive"),
    );

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
    const activeWriter = await Effect.runPromise(
      locks.acquireEffect(workspace, "exclusive"),
    );
    const laterWriter = Effect.runPromise(
      locks.acquireEffect(workspace, "exclusive", undefined, 2),
    );
    const earlierWriter = Effect.runPromise(
      locks.acquireEffect(workspace, "exclusive", undefined, 1),
    );

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
