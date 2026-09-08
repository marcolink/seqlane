// @test-scope ./port.ts

import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { assertListenAvailable } from "./port.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("Ripwire listen preflight", () => {
  it("accepts an available loopback port", async () => {
    await assertListenAvailable("127.0.0.1:0");
  });

  it("rejects a port that is already bound", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("test server did not expose a port");
    await expect(
      assertListenAvailable(`127.0.0.1:${address.port}`),
    ).rejects.toThrow("already in use");
  });
});
