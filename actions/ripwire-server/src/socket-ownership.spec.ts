// @test-scope ./socket-ownership.ts

import { describe, expect, it } from "vitest";
import {
  assertListenOwnedByProcess,
  ListenOwnershipError,
  parseListeningEndpoints,
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

  it("parses Linux listener endpoints with their PIDs", () => {
    expect(
      parseListeningEndpoints(
        'LISTEN 0 128 127.0.0.1:7998 0.0.0.0:* users:(("ripwire",pid=101,fd=3))',
        "linux",
      ),
    ).toEqual([{ host: "127.0.0.1", port: 7998, pid: 101 }]);
  });

  it("parses macOS lsof owner PIDs", () => {
    expect(parseListeningPids("p101\nf101\np101\n", "darwin")).toEqual([101]);
  });

  it("parses macOS listener endpoints with their PIDs", () => {
    expect(
      parseListeningEndpoints("p101\nf101\nn127.0.0.1:7998\n", "darwin"),
    ).toEqual([{ host: "127.0.0.1", port: 7998, pid: 101 }]);
  });

  it("rejects malformed listener endpoint output", () => {
    expect(
      parseListeningEndpoints(
        'LISTEN 0 128 malformed 0.0.0.0:* users:(("ripwire",pid=101,fd=3))',
        "linux",
      ),
    ).toEqual([]);
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

  it("does not accept the spawned group on another loopback address", async () => {
    await expect(
      assertListenOwnedByProcess(
        "127.0.0.1:7998",
        service,
        async (pid) =>
          pid === service.pid
            ? service.identity
            : { processGroupId: 200, processStartTime: "racer-start" },
        "linux",
        async () => ({
          stdout: [
            'LISTEN 0 128 127.0.0.2:7998 0.0.0.0:* users:(("ripwire",pid=101,fd=3))',
            'LISTEN 0 128 127.0.0.1:7998 0.0.0.0:* users:(("racer",pid=202,fd=3))',
          ].join("\n"),
        }),
      ),
    ).rejects.toBeInstanceOf(ListenOwnershipError);
  });

  it("does not accept another macOS loopback listener on the configured port", async () => {
    await expect(
      assertListenOwnedByProcess(
        "127.0.0.1:7998",
        service,
        async (pid) =>
          pid === service.pid
            ? service.identity
            : { processGroupId: 200, processStartTime: "racer-start" },
        "darwin",
        async () => ({
          stdout: [
            "p101",
            "f101",
            "n127.0.0.2:7998",
            "p202",
            "f202",
            "n127.0.0.1:7998",
          ].join("\n"),
        }),
      ),
    ).rejects.toBeInstanceOf(ListenOwnershipError);
  });

  it("matches localhost with its supported loopback address", async () => {
    await expect(
      assertListenOwnedByProcess(
        "localhost:7998",
        service,
        async () => service.identity,
        "darwin",
        async () => ({ stdout: "p101\nf101\nn127.0.0.1:7998\n" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("matches macOS wildcard output for a configured wildcard address", async () => {
    await expect(
      assertListenOwnedByProcess(
        "0.0.0.0:7998",
        service,
        async () => service.identity,
        "darwin",
        async () => ({ stdout: "p101\nf101\nn*:7998\n" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not let macOS wildcard output satisfy a specific address", async () => {
    await expect(
      assertListenOwnedByProcess(
        "127.0.0.1:7998",
        service,
        async () => service.identity,
        "darwin",
        async () => ({ stdout: "p101\nf101\nn*:7998\n" }),
      ),
    ).rejects.toBeInstanceOf(ListenOwnershipError);
  });
});
