import { describe, expect, it, vi } from "vitest";
import { sendWithAcknowledgement } from "./ipc-ack.js";

describe("runner IPC acknowledgement", () => {
  it("waits for the send callback", async () => {
    await expect(
      sendWithAcknowledgement((acknowledge) => {
        acknowledge();
        return true;
      }, 50),
    ).resolves.toBeUndefined();
  });

  it("propagates callback errors", async () => {
    const failure = new Error("IPC failed");
    await expect(
      sendWithAcknowledgement((acknowledge) => {
        acknowledge(failure);
        return true;
      }, 50),
    ).rejects.toBe(failure);
  });

  it("bounds a callback that never acknowledges", async () => {
    await expect(sendWithAcknowledgement(() => true, 5)).rejects.toMatchObject({
      _tag: "TimeoutError",
    });
  });

  it("removes the supervisor listener when the callback acknowledges", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await sendWithAcknowledgement(
      (acknowledge) => {
        acknowledge();
        return true;
      },
      50,
      controller.signal,
    );

    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("removes the supervisor listener when the deadline interrupts the callback", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await expect(
      sendWithAcknowledgement(() => true, 5, controller.signal),
    ).rejects.toMatchObject({ _tag: "TimeoutError" });

    expect(remove).toHaveBeenCalledOnce();
  });

  it("preserves the exact supervisor abort reason", async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ source: "supervisor" });
    const pending = sendWithAcknowledgement(() => true, 50, controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("preserves a null supervisor abort reason", async () => {
    const controller = new AbortController();
    const pending = sendWithAcknowledgement(() => true, 50, controller.signal);
    controller.abort(null);

    await expect(pending).rejects.toBeNull();
  });

  it("preserves an undefined supervisor abort reason", async () => {
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "reason", { value: undefined });
    const pending = sendWithAcknowledgement(() => true, 50, controller.signal);
    controller.abort(null);

    await expect(pending).rejects.toBeUndefined();
  });

  it("preserves a non-Error supervisor abort reason", async () => {
    const controller = new AbortController();
    const reason = "worker disconnected";
    const pending = sendWithAcknowledgement(() => true, 50, controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});
