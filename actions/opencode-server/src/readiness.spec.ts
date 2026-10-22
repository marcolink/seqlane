import { Effect } from "effect";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForHttpHealth } from "./readiness.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OpenCode readiness", () => {
  it("releases failed HTTP response bodies while retrying", async () => {
    const response = new Response("not ready", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel");
    globalThis.fetch = vi.fn(async () => response);

    await expect(
      Effect.runPromise(waitForHttpHealth("http://127.0.0.1:1", 10)),
    ).rejects.toThrow("Service did not become ready");

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts a real HTTP readiness request at the Effect deadline", async () => {
    const server = createServer((_request, response) => {
      response.once("close", () => responseClosed?.());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("no test port");
    let responseClosed: (() => void) | undefined;
    const requestClosed = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });

    try {
      await expect(
        Effect.runPromise(
          waitForHttpHealth(`http://127.0.0.1:${address.port}`, 100),
        ),
      ).rejects.toThrow("Service did not become ready");
      await requestClosed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
