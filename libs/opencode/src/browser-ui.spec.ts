// @test-scope ./browser-ui.ts
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { resolveOpenCodeBrowserUiUrl } from "./browser-ui.js";

async function startServer(contentType: string): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": contentType });
    response.end("response");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Server did not expose a TCP address");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

describe("OpenCode browser UI discovery", () => {
  it("returns the configured runtime origin when it serves HTML", async () => {
    const fake = await startServer("text/html; charset=utf-8");
    try {
      await expect(
        resolveOpenCodeBrowserUiUrl(fake.url, new AbortController().signal),
      ).resolves.toBe(fake.url);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("does not expose an API-only runtime as a browser UI", async () => {
    const fake = await startServer("application/json");
    try {
      await expect(
        resolveOpenCodeBrowserUiUrl(fake.url, new AbortController().signal),
      ).resolves.toBeUndefined();
    } finally {
      await closeServer(fake.server);
    }
  });

  it("rejects URLs that include credentials", async () => {
    await expect(
      resolveOpenCodeBrowserUiUrl(
        "http://user:password@127.0.0.1:4096",
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });
});
