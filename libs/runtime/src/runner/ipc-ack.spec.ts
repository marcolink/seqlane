import { describe, expect, it } from "vitest";
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
});
