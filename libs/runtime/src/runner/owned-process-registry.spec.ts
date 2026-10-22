// @test-scope ./owned-process-registry.ts

import {
  decodeOwnedProcessFrame,
  type OwnedProcessIdentity,
} from "@seqlane/protocol/private/owned-process";
import type { OwnedProcessRegistryHost } from "./owned-process-registry.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const processHelpers = vi.hoisted(() => ({
  captureOwnedProcessIdentity: vi.fn(),
  confirmOwnedProcessGroupStopped: vi.fn(),
  confirmOwnedProcessStopped: vi.fn(),
  terminateOwnedProcess: vi.fn(),
}));

vi.mock("../private/owned-process/index.js", () => processHelpers);

import { OwnedProcessRegistry } from "./owned-process-registry.js";

const identityFor = (pid: number): OwnedProcessIdentity => ({
  version: 1,
  platform: "darwin",
  pid,
  processGroupId: pid,
  birthIdentity: `birth-${pid}`,
});

function acknowledgedHost(
  onFrame?: (frame: ReturnType<typeof decodeOwnedProcessFrame>) => void,
) {
  let registry: OwnedProcessRegistry | undefined;
  const host = {
    send: vi.fn(
      (message: string, callback?: (error?: Error | null) => void) => {
        const frame = decodeOwnedProcessFrame(message);
        onFrame?.(frame);
        registry?.acceptAcknowledgement({
          type: "runner.owned-process.ack",
          action: frame.action,
          id: frame.id,
          identity: frame.identity,
        });
        callback?.();
        return true;
      },
    ),
  };
  const attach = (value: OwnedProcessRegistry): void => {
    registry = value;
  };
  return { host, attach };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("owned process registry", () => {
  it("rejects unavailable identity when native group shutdown is unconfirmed", async () => {
    const cause = new Error("Identity unavailable");
    processHelpers.captureOwnedProcessIdentity.mockRejectedValue(cause);
    processHelpers.confirmOwnedProcessGroupStopped.mockResolvedValue(false);
    const { host, attach } = acknowledgedHost();
    const registry = new OwnedProcessRegistry(host, 25);
    attach(registry);

    await expect(registry.register(40)).rejects.toBe(cause);
    expect(host.send).not.toHaveBeenCalled();
    expect(processHelpers.terminateOwnedProcess).not.toHaveBeenCalled();
  });

  it("preserves supervisor disconnect after a child has already stopped", async () => {
    processHelpers.captureOwnedProcessIdentity.mockRejectedValue(
      new Error("Process no longer exists"),
    );
    processHelpers.confirmOwnedProcessGroupStopped.mockResolvedValue(true);
    const { host, attach } = acknowledgedHost();
    const registry = new OwnedProcessRegistry(host, 25);
    attach(registry);
    registry.supervisorDisconnected();

    await expect(registry.register(40)).rejects.toThrow(
      "Runner supervisor disconnected",
    );
    expect(host.send).not.toHaveBeenCalled();
    expect(processHelpers.terminateOwnedProcess).not.toHaveBeenCalled();
  });

  it("requires a matching ACK before keeping a process lease", async () => {
    processHelpers.captureOwnedProcessIdentity.mockImplementation(
      async (pid: number) => identityFor(pid),
    );
    processHelpers.confirmOwnedProcessStopped.mockResolvedValue(true);
    const { host, attach } = acknowledgedHost();
    const registry = new OwnedProcessRegistry(host, 25);
    attach(registry);

    await registry.register(41);
    await registry.releaseStoppedProcesses();

    expect(host.send).toHaveBeenCalledTimes(2);
    const actions = host.send.mock.calls.map(
      ([message]) => decodeOwnedProcessFrame(message).action,
    );
    expect(actions).toEqual(["register", "release"]);
  });

  it("releases confirmed stopped leases before registering later work", async () => {
    processHelpers.captureOwnedProcessIdentity.mockImplementation(
      async (pid: number) => identityFor(pid),
    );
    processHelpers.confirmOwnedProcessStopped.mockResolvedValue(true);
    const { host, attach } = acknowledgedHost();
    const registry = new OwnedProcessRegistry(host, 25);
    attach(registry);

    for (let pid = 1; pid <= 70; pid += 1) await registry.register(pid);
    await registry.releaseStoppedProcesses();

    const actions = host.send.mock.calls.map(
      ([message]) => decodeOwnedProcessFrame(message).action,
    );
    expect(actions.filter((action) => action === "register")).toHaveLength(70);
    expect(actions.filter((action) => action === "release")).toHaveLength(70);
  });

  it("drains registration before releasing a child stopped during its ACK", async () => {
    processHelpers.captureOwnedProcessIdentity.mockResolvedValue(
      identityFor(41),
    );
    processHelpers.confirmOwnedProcessStopped.mockResolvedValue(true);
    const frames: ReturnType<typeof decodeOwnedProcessFrame>[] = [];
    const registry = new OwnedProcessRegistry({
      send(message, callback) {
        const frame = decodeOwnedProcessFrame(message);
        frames.push(frame);
        if (frame.action === "release") acknowledge(frame);
        callback?.();
        return true;
      },
    });
    const acknowledge = (frame: ReturnType<typeof decodeOwnedProcessFrame>) =>
      registry.acceptAcknowledgement({
        ...frame,
        type: "runner.owned-process.ack",
      });
    const registration = registry.register(41);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    let released = false;
    const release = registry.releaseStoppedProcesses().then(() => {
      released = true;
    });
    try {
      // Drain ready microtasks while registration remains behind the ACK gate.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(released).toBe(false);
      acknowledge(frames[0]!);
      await Promise.all([registration, release]);
      expect(frames.map((frame) => frame.action)).toEqual([
        "register",
        "release",
      ]);
    } finally {
      acknowledge(frames[0]!);
      await Promise.allSettled([registration, release]);
    }
  });

  it("bounds release while registration identity capture is still pending", async () => {
    let finishCapture!: (identity: OwnedProcessIdentity) => void;
    processHelpers.captureOwnedProcessIdentity.mockReturnValue(
      new Promise<OwnedProcessIdentity>((resolve) => {
        finishCapture = resolve;
      }),
    );
    processHelpers.confirmOwnedProcessStopped.mockResolvedValue(true);
    const { host, attach } = acknowledgedHost();
    const registry = new OwnedProcessRegistry(host, 25);
    attach(registry);
    const registration = registry.register(41);
    try {
      await expect(registry.releaseStoppedProcesses()).rejects.toThrow(
        "timed out",
      );
      expect(host.send).not.toHaveBeenCalled();
    } finally {
      finishCapture(identityFor(41));
      await registration;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        host.send.mock.calls.map(
          ([message]) => decodeOwnedProcessFrame(message).action,
        ),
      ).toEqual(["register"]);
      await registry.releaseStoppedProcesses();
    }
  });

  it("fails a registration whose supervisor ACK does not match", async () => {
    processHelpers.captureOwnedProcessIdentity.mockImplementation(
      async (pid: number) => identityFor(pid),
    );
    processHelpers.terminateOwnedProcess.mockResolvedValue({ confirmed: true });
    const hostRegistry: { current?: OwnedProcessRegistry } = {};
    const host = {
      send: vi.fn(
        (message: string, callback?: (error?: Error | null) => void) => {
          const frame = decodeOwnedProcessFrame(message);
          hostRegistry.current?.acceptAcknowledgement({
            type: "runner.owned-process.ack",
            action: frame.action,
            id: frame.id,
            identity: { ...frame.identity, birthIdentity: "wrong-birth" },
          });
          callback?.();
          return true;
        },
      ),
    };
    const registry = new OwnedProcessRegistry(host, 25);
    hostRegistry.current = registry;

    await expect(registry.register(42)).rejects.toThrow(
      "Owned process acknowledgement did not match",
    );
    expect(processHelpers.terminateOwnedProcess).toHaveBeenCalledWith(
      identityFor(42),
      "SIGTERM",
    );
  });

  it("bounds a hung host send and cleans up the acquired process", async () => {
    processHelpers.captureOwnedProcessIdentity.mockImplementation(
      async (pid: number) => identityFor(pid),
    );
    processHelpers.terminateOwnedProcess
      .mockResolvedValueOnce({ confirmed: false })
      .mockResolvedValueOnce({ confirmed: true });
    const host = {
      send: vi.fn<OwnedProcessRegistryHost["send"]>(() => true),
    };
    const registry = new OwnedProcessRegistry(host, 10);

    await expect(registry.register(43)).rejects.toThrow("timed out");
    const sentFrame = decodeOwnedProcessFrame(host.send.mock.calls[0]![0]);
    expect(
      registry.acceptAcknowledgement({
        type: "runner.owned-process.ack",
        action: sentFrame.action,
        id: sentFrame.id,
        identity: sentFrame.identity,
      }),
    ).toBe(false);
    expect(processHelpers.terminateOwnedProcess).toHaveBeenNthCalledWith(
      1,
      identityFor(43),
      "SIGTERM",
    );
    expect(processHelpers.terminateOwnedProcess).toHaveBeenNthCalledWith(
      2,
      identityFor(43),
      "SIGKILL",
    );
  });

  it("cleans up a registration when the supervisor disconnects before ACK", async () => {
    processHelpers.captureOwnedProcessIdentity.mockImplementation(
      async (pid: number) => identityFor(pid),
    );
    processHelpers.terminateOwnedProcess.mockResolvedValue({ confirmed: true });
    const host = {
      send: vi.fn<OwnedProcessRegistryHost["send"]>(() => true),
    };
    const registry = new OwnedProcessRegistry(host, 1_000);

    const registration = registry.register(44);
    await vi.waitFor(() => expect(host.send).toHaveBeenCalledOnce());
    registry.supervisorDisconnected();

    await expect(registration).rejects.toThrow(
      "Runner supervisor disconnected",
    );
    const sentFrame = decodeOwnedProcessFrame(host.send.mock.calls[0]![0]);
    expect(
      registry.acceptAcknowledgement({
        type: "runner.owned-process.ack",
        action: sentFrame.action,
        id: sentFrame.id,
        identity: sentFrame.identity,
      }),
    ).toBe(false);
    expect(processHelpers.terminateOwnedProcess).toHaveBeenCalledWith(
      identityFor(44),
      "SIGTERM",
    );

    await expect(registry.register(45)).rejects.toThrow(
      "Runner supervisor disconnected",
    );
    expect(host.send).toHaveBeenCalledOnce();
    expect(processHelpers.terminateOwnedProcess).toHaveBeenCalledWith(
      identityFor(45),
      "SIGTERM",
    );
    await expect(
      processHelpers.terminateOwnedProcess.mock.results.at(-1)?.value,
    ).resolves.toEqual({ confirmed: true });
  });
});
