// @test-scope ./socket-ownership.ts

import { describe, expect, it } from "vitest";
import {
  assertListenOwnedByProcess,
  ListenOwnershipError,
  parseListeningPids,
} from "./socket-ownership.js";

const service = {
  pid: 101,
  identity: { processGroupId: 100, processStartTime: "service-start" },
};

describe("Ripwire listen ownership", () => {
  it("parses Linux socket owner PIDs", () => {
    expect(
      parseListeningPids(
        'LISTEN 0 128 127.0.0.1:7998 0.0.0.0:* users:(("ripwire",pid=101,fd=3))',
        "linux",
      ),
    ).toEqual([101]);
  });

  it("parses macOS lsof owner PIDs", () => {
    expect(parseListeningPids("p101\nf101\np101\n", "darwin")).toEqual([101]);
  });

  it("accepts a socket owned by the spawned process group", async () => {
    let commandTimeout = 0;
    let commandPath = "";
    await expect(
      assertListenOwnedByProcess(
        "127.0.0.1:7998",
        service,
        async () => service.identity,
        "linux",
        async (command, _args, options) => {
          commandPath = command;
          commandTimeout = options.timeout;
          return {
            stdout:
              'LISTEN 0 128 127.0.0.1:7998 0.0.0.0:* users:(("ripwire",pid=101,fd=3))',
          };
        },
      ),
    ).resolves.toBeUndefined();
    expect(commandPath).toBe("/usr/bin/ss");
    expect(commandTimeout).toBe(600_000);
  });

  it("passes the remaining probe timeout to the ownership command", async () => {
    let commandTimeout = 0;
    await expect(
      assertListenOwnedByProcess(
        "127.0.0.1:7998",
        service,
        async () => service.identity,
        321,
        async (_command, _args, options) => {
          commandTimeout = options.timeout;
          return { stdout: "" };
        },
      ),
    ).rejects.toBeInstanceOf(ListenOwnershipError);
    expect(commandTimeout).toBe(321);
  });

  it("rejects an unrelated socket owner", async () => {
    let commandPath = "";
    await expect(
      assertListenOwnedByProcess(
        "localhost:7998",
        service,
        async () => ({
          processGroupId: 200,
          processStartTime: "racer-start",
        }),
        "darwin",
        async (command, _args, _options) => {
          commandPath = command;
          return { stdout: "p202\nf3\n" };
        },
      ),
    ).rejects.toBeInstanceOf(ListenOwnershipError);
    expect(commandPath).toBe("/usr/sbin/lsof");
  });
});
