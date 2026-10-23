import * as processOwnership from "@seqlane/agent-adapter/private/owned-process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runGitCommand } from "./git-process.js";

function shortCommand(onUncertain?: (cause: unknown) => void) {
  return runGitCommand({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('done')"],
    cwd: process.cwd(),
    onUncertain,
  });
}

describe.skipIf(process.platform === "win32")("Git process ownership", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts read-only group absence when a short command loses its birth identity", async () => {
    vi.spyOn(processOwnership, "captureOwnedProcessIdentity").mockRejectedValue(
      new Error("identity unavailable"),
    );
    vi.spyOn(
      processOwnership,
      "confirmOwnedProcessGroupStopped",
    ).mockResolvedValue(true);
    const terminate = vi.spyOn(processOwnership, "terminateOwnedProcess");
    const onUncertain = vi.fn();

    await expect(shortCommand(onUncertain)).resolves.toMatchObject({
      exitCode: 0,
      stdout: "done",
    });
    expect(terminate).not.toHaveBeenCalled();
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it("reports an unverified surviving group without signaling it", async () => {
    vi.spyOn(processOwnership, "captureOwnedProcessIdentity").mockRejectedValue(
      new Error("identity unavailable"),
    );
    vi.spyOn(
      processOwnership,
      "confirmOwnedProcessGroupStopped",
    ).mockResolvedValue(false);
    const terminate = vi.spyOn(processOwnership, "terminateOwnedProcess");
    const onUncertain = vi.fn();

    await expect(shortCommand(onUncertain)).rejects.toThrow(
      "no verified identity",
    );
    expect(onUncertain).toHaveBeenCalledWith(expect.any(Error));
    expect(terminate).not.toHaveBeenCalled();
  });

  it.each([undefined, null, false, 0, ""])(
    "retains falsey group inspection failures (%s)",
    async (cause) => {
      vi.spyOn(
        processOwnership,
        "confirmOwnedProcessGroupStopped",
      ).mockRejectedValue(cause);
      const onUncertain = vi.fn();

      await expect(shortCommand(onUncertain)).rejects.toBe(cause);
      expect(onUncertain).toHaveBeenCalledWith(cause);
    },
  );

  it("preserves cleanup failure when its retention notification throws", async () => {
    const cause = new Error("group inspection unavailable");
    vi.spyOn(
      processOwnership,
      "confirmOwnedProcessGroupStopped",
    ).mockRejectedValue(cause);

    await expect(
      shortCommand(() => {
        throw new Error("notification failed");
      }),
    ).rejects.toBe(cause);
  });

  it("starts no child for a pre-cancelled command", async () => {
    const capture = vi.spyOn(processOwnership, "captureOwnedProcessIdentity");
    const controller = new AbortController();
    controller.abort();
    await expect(
      runGitCommand({
        executable: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ exitCode: 1 });
    expect(capture).not.toHaveBeenCalled();
  });
});
