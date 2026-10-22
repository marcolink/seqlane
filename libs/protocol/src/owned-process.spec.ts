import { describe, expect, it } from "vitest";
import {
  decodeOwnedProcessAcknowledgement,
  decodeOwnedProcessFrame,
  encodeOwnedProcessAcknowledgement,
  encodeOwnedProcessFrame,
  isOwnedProcessAcknowledgementCandidate,
  isOwnedProcessFrameCandidate,
  ownedProcessFrameSchema,
  type OwnedProcessIdentity,
} from "./owned-process.js";

const identity: OwnedProcessIdentity = {
  version: 1,
  pid: 123,
  processGroupId: 123,
  platform: "linux",
  birthIdentity: "7812",
};

describe("owned process private frames", () => {
  it("round trips register, release, and acknowledgements", () => {
    const frame = {
      type: "runner.owned-process",
      action: "register",
      id: "agent-1",
      identity,
    } as const;
    expect(decodeOwnedProcessFrame(encodeOwnedProcessFrame(frame))).toEqual(
      frame,
    );
    const acknowledgement = {
      type: "runner.owned-process.ack",
      action: "release",
      id: "agent-1",
      identity,
    } as const;
    expect(
      decodeOwnedProcessAcknowledgement(
        encodeOwnedProcessAcknowledgement(acknowledgement),
      ),
    ).toEqual(acknowledgement);
    const encodedFrame = encodeOwnedProcessFrame(frame);
    expect(isOwnedProcessFrameCandidate(encodedFrame)).toBe(true);
    expect(decodeOwnedProcessFrame(encodedFrame)).toEqual(frame);
    expect(isOwnedProcessAcknowledgementCandidate(acknowledgement)).toBe(true);
    expect(isOwnedProcessFrameCandidate({ type: "event" })).toBe(false);
  });

  it("rejects malformed, nonleader, foreign, and oversized records", () => {
    expect(() => decodeOwnedProcessFrame("{")).toThrow(
      "Invalid owned process frame",
    );
    expect(() =>
      encodeOwnedProcessFrame({
        type: "runner.owned-process",
        action: "register",
        id: "x",
        identity: { ...identity, pid: 456 },
      }),
    ).toThrow("Invalid owned process frame");
    expect(
      ownedProcessFrameSchema.safeParse({
        type: "runner.owned-process",
        action: "register",
        id: "x",
        identity: { ...identity, processGroupId: 456 },
      }).success,
    ).toBe(false);
    expect(() => decodeOwnedProcessFrame(" ".repeat(16 * 1024 + 1))).toThrow(
      "Invalid owned process frame",
    );
  });
});
