import { describe, expect, it } from "vitest";
import { waitForHttpHealth } from "./readiness.js";

describe("OpenCode readiness", () => {
  it("releases failed HTTP readiness response bodies", async () => {
    const cancelled: boolean[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      ({
        ok: false,
        body: { cancel: async () => cancelled.push(true) },
      }) as unknown as Response;

    try {
      await expect(waitForHttpHealth("http://127.0.0.1:1", 1)).rejects.toThrow(
        "Service did not become ready",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(cancelled).toEqual([true]);
  }, 5_000);
});
