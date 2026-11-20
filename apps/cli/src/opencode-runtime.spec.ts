// @test-scope ./opencode-runtime.ts
// @test-scope ./agent-runtime.ts
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createDirectRunAdapterConfiguration,
  directRunAdapterConfigurationEnvironment,
  loadDirectRunAgentRuntimeFactory,
} from "./agent-runtime.js";

describe("automatic OpenCode CLI selection", () => {
  it.each([
    ["1.18.27", "opencode", true],
    ["2.1.2", "opencode-v2", false],
  ])(
    "selects %s and its actual capabilities before creating sessions",
    async (version, identity, fork) => {
      const paths: string[] = [];
      const authorization = `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`;
      const server = createServer((request, response) => {
        paths.push(request.url ?? "");
        if (request.headers.authorization !== authorization) {
          response.writeHead(401).end();
          return;
        }
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/info") {
          if (version.startsWith("1.")) response.writeHead(404).end();
          else response.end(JSON.stringify({ version, pid: 1, urls: [] }));
        } else if (request.url === "/global/health") {
          response.end(JSON.stringify({ healthy: true, version }));
        } else if (request.url?.startsWith("/api/model")) {
          response.end(JSON.stringify({ data: [] }));
        } else response.writeHead(404).end();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("No address");
      try {
        const factory = loadDirectRunAgentRuntimeFactory({
          OPENCODE_SERVER_PASSWORD: "fixture-password",
          [directRunAdapterConfigurationEnvironment]:
            createDirectRunAdapterConfiguration({
              adapter: "opencode",
              mode: "external",
              host: "127.0.0.1",
              port: address.port,
            }),
        });
        const runtime = await factory(AbortSignal.timeout(5000), process.cwd());
        expect(runtime.identity).toBe(identity);
        expect(runtime.capabilities.fork).toBe(fork);
        expect(paths.some((path) => path.includes("/session"))).toBe(false);
        await runtime.close?.();
        expect(
          (
            await fetch(`http://127.0.0.1:${address.port}/api/info`, {
              headers: { authorization },
            })
          ).status,
        ).toBe(version.startsWith("1.") ? 404 : 200);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
