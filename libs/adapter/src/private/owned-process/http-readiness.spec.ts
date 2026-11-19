import { Effect } from "effect";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpHealthcheckError,
  HttpReadinessError,
  waitForHttpHealth,
} from "./http-readiness.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("shared HTTP readiness", () => {
  it("preserves the last transport failure as the deadline cause", async () => {
    const cause = new Error("connection refused");
    await expect(
      Effect.runPromise(
        waitForHttpHealth({
          url: "http://127.0.0.1:1",
          timeoutMs: 30,
          pollIntervalMs: 1,
          fetch: vi.fn(async () => {
            throw cause;
          }),
        }),
      ),
    ).rejects.toMatchObject({
      name: HttpReadinessError.name,
      code: "HTTP_READINESS_TIMEOUT",
      cause: expect.objectContaining({ cause }),
    });
  });

  it("waits for endpoint discovery and sends the required authorization", async () => {
    const endpoint = "http://127.0.0.1:4096/global/health";
    let checks = 0;
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(endpoint);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Basic secret",
      );
      return new Response(null, { status: 200 });
    });
    await expect(
      Effect.runPromise(
        waitForHttpHealth({
          url: () => (checks < 2 ? undefined : endpoint),
          timeoutMs: 100,
          pollIntervalMs: 1,
          beforeAttempt: Effect.sync(() => {
            checks++;
          }),
          headers: { authorization: "Basic secret" },
          fetch: request,
        }),
      ),
    ).resolves.toBe(endpoint);
    expect(request).toHaveBeenCalledOnce();
  });

  it("stops immediately on a lifecycle failure without retrying it", async () => {
    const cause = new Error("child exited");
    const request = vi.fn();
    await expect(
      Effect.runPromise(
        waitForHttpHealth({
          url: "http://127.0.0.1:1",
          timeoutMs: 100,
          beforeAttempt: Effect.fail(cause),
          fetch: request,
        }),
      ),
    ).rejects.toBe(cause);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([new Error("fatal check failure"), null, false])(
    "preserves a fatal healthcheck rejection without retrying",
    async (cause) => {
      const healthcheck = vi.fn(async () => {
        throw cause;
      });
      await expect(
        Effect.runPromise(
          waitForHttpHealth({
            url: "http://127.0.0.1:1",
            timeoutMs: 100,
            healthcheck,
          }),
        ),
      ).rejects.toMatchObject({
        name: HttpHealthcheckError.name,
        cause,
      });
      expect(healthcheck).toHaveBeenCalledOnce();
    },
  );

  it("releases failed HTTP response bodies while retrying", async () => {
    const response = new Response("not ready", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel");
    globalThis.fetch = vi.fn(async () => response);

    await expect(
      Effect.runPromise(
        waitForHttpHealth({ url: "http://127.0.0.1:1", timeoutMs: 10 }),
      ),
    ).rejects.toThrow("Health returned HTTP 503");

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retries a real unhealthy response until the server becomes ready", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(requests === 1 ? 503 : 200).end("health");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("no test port");
    try {
      await Effect.runPromise(
        waitForHttpHealth({
          url: `http://127.0.0.1:${address.port}`,
          timeoutMs: 3_000,
        }),
      );
      expect(requests).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("recovers when the listening server drops its first health request", async () => {
    const server = createServer();
    let connections = 0;
    let handlerTimer: ReturnType<typeof setTimeout> | undefined;
    server.on("connection", () => connections++);
    server.once("connection", () => {
      handlerTimer = setTimeout(() => {
        server.on("request", (_request, response) => response.end("healthy"));
      }, 100);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("no test port");
    try {
      await Effect.runPromise(
        waitForHttpHealth({
          url: `http://127.0.0.1:${address.port}`,
          timeoutMs: 5_000,
        }),
      );
      expect(connections).toBeGreaterThanOrEqual(2);
    } finally {
      clearTimeout(handlerTimer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

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
          waitForHttpHealth({
            url: `http://127.0.0.1:${address.port}`,
            timeoutMs: 100,
          }),
        ),
      ).rejects.toThrow("Service did not become ready");
      await requestClosed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
