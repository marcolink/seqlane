import { describe, expect, it } from "vitest";
import { decodeTraceCarrier, encodeTraceCarrier } from "./trace-carrier.js";

const carrier = {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "vendor=value",
};

describe("private trace carrier", () => {
  it("round-trips validated W3C context", () => {
    expect(decodeTraceCarrier(encodeTraceCarrier(carrier))).toEqual(carrier);
  });

  it.each([
    "not-json",
    JSON.stringify({
      traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    }),
    JSON.stringify({ ...carrier, unexpected: true }),
  ])("rejects malformed carrier %s", (encoded) => {
    expect(() => decodeTraceCarrier(encoded)).toThrow("Invalid trace carrier");
  });
});
