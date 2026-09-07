// @test-scope ./cache.ts

import { describe, expect, it, vi } from "vitest";
import { tryRestore, trySave, type CachePort } from "./cache.js";

function fakeCache(overrides: Partial<CachePort> = {}): CachePort {
  return {
    restore: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

describe("exact OpenCode cache handling", () => {
  it("accepts only an exact primary key", async () => {
    const cache = fakeCache({
      restore: vi.fn().mockResolvedValue("other-key"),
    });
    const onError = vi.fn();
    await expect(
      tryRestore(cache, "/tmp/install", "requested-key", onError),
    ).resolves.toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not fail setup when restore or save is unavailable", async () => {
    const cache = fakeCache({
      restore: vi.fn().mockRejectedValue(new Error("restore denied")),
      save: vi.fn().mockRejectedValue(new Error("save denied")),
    });
    const onError = vi.fn();
    await expect(
      tryRestore(cache, "/tmp/install", "key", onError),
    ).resolves.toBe(false);
    await expect(
      trySave(cache, "/tmp/install", "key", onError),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("passes one exact installation directory without restore keys", async () => {
    const cache = fakeCache({ restore: vi.fn().mockResolvedValue("key") });
    await tryRestore(cache, "/tmp/install", "key", () => undefined);
    await trySave(cache, "/tmp/install", "key", () => undefined);
    expect(cache.restore).toHaveBeenCalledWith("/tmp/install", "key");
    expect(cache.save).toHaveBeenCalledWith("/tmp/install", "key");
  });
});
