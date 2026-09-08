// @test-scope ./state.ts

import { describe, expect, it } from "vitest";
import {
  parseCleanupOnlyState,
  parseServiceState,
  serializeCleanupOnlyState,
  serializeServiceState,
  serviceStateSchema,
} from "./state.js";

const state = {
  pid: 42,
  identity: { processGroupId: 42, processStartTime: "start" },
  sentinel: {
    pid: 41,
    identity: { processGroupId: 42, processStartTime: "sentinel-start" },
  },
};

describe("Ripwire service state", () => {
  it("round-trips and validates the cleanup-only state", () => {
    expect(parseCleanupOnlyState(serializeCleanupOnlyState())).toBe(true);
    expect(parseCleanupOnlyState(JSON.stringify({ kind: "other" }))).toBe(
      false,
    );
    expect(parseCleanupOnlyState("not-json")).toBe(false);
  });

  it("round-trips one validated state value", () => {
    const serialized = serializeServiceState(state);
    expect(parseServiceState(serialized)).toEqual(state);
    expect(serviceStateSchema.safeParse(state).success).toBe(true);
  });

  it("rejects malformed or incomplete state", () => {
    expect(parseServiceState("not-json")).toBeUndefined();
    expect(parseServiceState(JSON.stringify({ pid: 42 }))).toBeUndefined();
    expect(
      parseServiceState(
        JSON.stringify({
          ...state,
          identity: { ...state.identity, processGroupId: 0 },
        }),
      ),
    ).toBeUndefined();
  });

  it("accepts primary ownership without a validated sentinel", () => {
    const primaryOnly = {
      pid: 42,
      identity: { processGroupId: 42, processStartTime: "service-start" },
    };
    expect(parseServiceState(JSON.stringify(primaryOnly))).toEqual(primaryOnly);
  });
});
