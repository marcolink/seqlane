import { describe, expect, it } from "vitest";
import { ChildSessionRegistry } from "./child-session.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("ChildSessionRegistry", () => {
  it("retains the parent until every child session terminates", async () => {
    const registry = new ChildSessionRegistry();
    const firstChild = deferred<void>();
    const secondChild = deferred<void>();
    const first = registry.register("parent", firstChild.promise);
    const second = registry.register("parent", secondChild.promise);

    expect(registry.parentInvocationIds()).toEqual(["parent"]);
    expect(registry.parentInvocationFor(first.child)).toBe("parent");
    expect(registry.parentInvocationFor(second.child)).toBe("parent");

    firstChild.resolve();
    await first.termination;
    expect(registry.parentInvocationIds()).toEqual(["parent"]);
    expect(registry.parentInvocationFor(first.child)).toBeUndefined();
    expect(registry.parentInvocationFor(second.child)).toBe("parent");

    secondChild.resolve();
    await second.termination;
    expect(registry.parentInvocationIds()).toEqual([]);
  });
});
