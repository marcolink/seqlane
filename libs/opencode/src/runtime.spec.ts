// @test-scope ./runtime.ts
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createOpenCodeAgentRuntimeFactory } from "./runtime.js";

async function startBrowserUiServer(): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("OpenCode browser UI fixture has no TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

describe("OpenCode agent runtime composition", () => {
  it("discovers the browser UI and creates an adapter with matching capabilities", async () => {
    const browserUi = await startBrowserUiServer();
    try {
      const factory = createOpenCodeAgentRuntimeFactory({
        adapter: "opencode",
        url: browserUi.url,
      });
      const runtime = await factory(
        new AbortController().signal,
        "/workspace-from-composition",
      );
      const adapter = runtime.createAdapter({
        signal: new AbortController().signal,
      });

      expect(runtime).toMatchObject({
        identity: "opencode",
        capabilities: {
          execute: true,
          modelSelection: true,
          checkpoint: true,
          fork: true,
          sessionUi: true,
        },
      });
      expect(adapter.capabilities).toEqual(runtime.capabilities);
    } finally {
      await browserUi.close();
    }
  });

  it("rejects a runtime URL with embedded credentials", () => {
    expect(() =>
      createOpenCodeAgentRuntimeFactory({
        adapter: "opencode",
        url: "https://token@example.test",
      }),
    ).toThrow(/embedded credentials/i);
  });
});
