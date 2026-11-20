import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectOpenCodeExecutableVersion,
  detectOpenCodeServerVersion,
} from "./version-detection.js";

const environment = { PATH: process.env.PATH, HOME: process.env.HOME };

async function executable(
  output: string,
  operation: (path: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "seqlane-version-"));
  const path = join(directory, "opencode");
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, {
    mode: 0o755,
  });
  try {
    await operation(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function server(
  info: unknown,
  health: unknown,
  operation: (url: string, paths: string[]) => Promise<void>,
  status = 200,
) {
  const paths: string[] = [];
  const native = createServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.headers.authorization !== "Basic fixture") {
      response.writeHead(401).end();
      return;
    }
    const value = request.url === "/api/info" ? info : health;
    response.writeHead(value === undefined ? 404 : status, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(value));
  });
  native.listen(0, "127.0.0.1");
  await once(native, "listening");
  const address = native.address();
  if (address === null || typeof address === "string")
    throw new Error("No address");
  try {
    await operation(`http://127.0.0.1:${address.port}`, paths);
  } finally {
    native.closeAllConnections();
    await new Promise<void>((resolve) => native.close(() => resolve()));
  }
}

describe("OpenCode version detection", () => {
  it.each([
    ["1.18.27", "v1"],
    ["opencode v1.14.19", "v1"],
    ["2.1.2", "v2"],
    ["opencode v2.1.2", "v2"],
  ])(
    "selects the implementation for executable %s",
    async (version, expected) => {
      await executable(version, async (path) => {
        await expect(
          detectOpenCodeExecutableVersion({
            executable: path,
            environment,
            signal: AbortSignal.timeout(5000),
          }),
        ).resolves.toBe(expected);
      });
    },
  );

  it.each(["2.1.3", "3.0.0", "2.1.2-beta.1", "1.18.27-beta.1", "invalid"])(
    "rejects unsupported or malformed executable version %s",
    async (version) => {
      await executable(version, async (path) => {
        await expect(
          detectOpenCodeExecutableVersion({
            executable: path,
            environment,
            signal: AbortSignal.timeout(5000),
          }),
        ).rejects.toThrow();
      });
    },
  );

  it("detects an authenticated V2 server using read-only information", async () => {
    await server(
      { version: "2.1.2", pid: 1, urls: [] },
      undefined,
      async (url, paths) => {
        await expect(
          detectOpenCodeServerVersion({
            url,
            authorization: "Basic fixture",
            signal: AbortSignal.timeout(5000),
          }),
        ).resolves.toBe("v2");
        expect(paths).toEqual(["/api/info"]);
      },
    );
  });

  it("detects V1 through its health endpoint when V2 information is absent", async () => {
    await server(
      undefined,
      { healthy: true, version: "1.18.27" },
      async (url, paths) => {
        await expect(
          detectOpenCodeServerVersion({
            url,
            authorization: "Basic fixture",
            signal: AbortSignal.timeout(5000),
          }),
        ).resolves.toBe("v1");
        expect(paths).toEqual(["/api/info", "/global/health"]);
      },
    );
  });

  it.each([
    { version: "2.1.3", pid: 1, urls: [] },
    { version: "2.1.2" },
    { version: "1.18.27", pid: 1, urls: [] },
  ])(
    "does not switch protocols after invalid server information",
    async (info) => {
      await server(
        info,
        { healthy: true, version: "1.18.27" },
        async (url, paths) => {
          await expect(
            detectOpenCodeServerVersion({
              url,
              authorization: "Basic fixture",
              signal: AbortSignal.timeout(5000),
            }),
          ).rejects.toThrow();
          expect(paths).toEqual(["/api/info"]);
        },
      );
    },
  );

  it("preserves authentication failure without another protocol probe", async () => {
    await server(
      { version: "2.1.2", pid: 1, urls: [] },
      undefined,
      async (url, paths) => {
        await expect(
          detectOpenCodeServerVersion({
            url,
            signal: AbortSignal.timeout(5000),
          }),
        ).rejects.toThrow();
        expect(paths).toEqual(["/api/info"]);
      },
    );
  });

  it("does not probe a cancelled connection", async () => {
    await server(
      { version: "2.1.2", pid: 1, urls: [] },
      undefined,
      async (url, paths) => {
        const controller = new AbortController();
        controller.abort();
        await expect(
          detectOpenCodeServerVersion({ url, signal: controller.signal }),
        ).rejects.toThrow();
        expect(paths).toEqual([]);
      },
    );
  });

  it.each([403, 500])(
    "does not switch protocols after HTTP %s",
    async (status) => {
      await server(
        { version: "2.1.2", pid: 1, urls: [] },
        { healthy: true, version: "1.18.27" },
        async (url, paths) => {
          await expect(
            detectOpenCodeServerVersion({
              url,
              authorization: "Basic fixture",
              signal: AbortSignal.timeout(5000),
            }),
          ).rejects.toThrow();
          expect(paths).toEqual(["/api/info"]);
        },
        status,
      );
    },
  );

  it("rejects oversized server information without trying another protocol", async () => {
    await server(
      { version: "2.1.2", pid: 1, urls: [], extra: "x".repeat(16_384) },
      undefined,
      async (url, paths) => {
        await expect(
          detectOpenCodeServerVersion({
            url,
            authorization: "Basic fixture",
            signal: AbortSignal.timeout(5000),
          }),
        ).rejects.toThrow("16 KiB");
        expect(paths).toEqual(["/api/info"]);
      },
    );
  });

  it("excludes unselected hooks and credentials from executable probing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seqlane-version-env-"));
    const path = join(directory, "opencode");
    await writeFile(
      path,
      '#!/bin/sh\nif [ -n "$NODE_OPTIONS$SEQLANE_UNSELECTED_KEY" ]; then exit 1; fi\nprintf "2.1.2\\n"\n',
      { mode: 0o755 },
    );
    try {
      await expect(
        detectOpenCodeExecutableVersion({
          executable: path,
          signal: AbortSignal.timeout(5000),
          environment: {
            ...environment,
            NODE_OPTIONS: "--inspect",
            SEQLANE_UNSELECTED_KEY: "fixture-secret",
          },
        }),
      ).resolves.toBe("v2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
