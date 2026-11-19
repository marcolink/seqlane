// @test-scope ./identity.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureOwnedProcessIdentity,
  isOwnedProcessIdentityCurrent,
  terminateOwnedProcess,
} from "./identity.js";

const probes = vi.hoisted(() => ({ read: vi.fn(), query: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: probes.read }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return {
    ...original,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: probes.query }),
  };
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const identity = {
  version: 1,
  platform: "linux",
  pid: 43123,
  processGroupId: 43123,
  birthIdentity: "1234",
} as const;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  probes.read.mockReset();
  probes.query.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
  vi.spyOn(process, "kill").mockReturnValue(true);
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
});

describe("Linux proc-stat disappearance", () => {
  it.each(["ENOENT", "ESRCH"])(
    "requires group absence after %s without authorizing a signal",
    async (code) => {
      const cause = Object.assign(new Error("process disappeared"), { code });
      probes.read.mockRejectedValue(cause);

      await expect(
        captureOwnedProcessIdentity(identity.pid),
      ).rejects.toMatchObject({
        code: "OWNED_PROCESS_IDENTITY_UNAVAILABLE",
      });
      expect(await isOwnedProcessIdentityCurrent(identity)).toBe(false);
      expect(await terminateOwnedProcess(identity, "SIGKILL")).toEqual({
        confirmed: true,
      });

      probes.query.mockResolvedValue({
        stdout: `43124 ${identity.processGroupId} S\n`,
        stderr: "",
      });
      expect(await terminateOwnedProcess(identity, "SIGKILL")).toEqual({
        confirmed: false,
      });
      expect(process.kill).not.toHaveBeenCalled();
    },
  );

  it.each(["EACCES", "EIO"])(
    "preserves %s uncertainty even when a group query would be empty",
    async (code) => {
      const cause = Object.assign(new Error("metadata unavailable"), { code });
      probes.read.mockRejectedValue(cause);

      await expect(
        isOwnedProcessIdentityCurrent(identity),
      ).rejects.toMatchObject({
        code: "OWNED_PROCESS_IDENTITY_UNAVAILABLE",
        cause,
      });
      await expect(
        terminateOwnedProcess(identity, "SIGKILL"),
      ).rejects.toMatchObject({
        code: "OWNED_PROCESS_IDENTITY_UNAVAILABLE",
        cause,
      });
      expect(probes.query).not.toHaveBeenCalled();
      expect(process.kill).not.toHaveBeenCalled();
    },
  );
});
