import { describe, expect, it } from "vitest";
import {
  captureTraceCarrierEnvironment,
  traceCarrierEnvironment,
} from "./trace-carrier-environment.js";

describe("private trace carrier startup environment", () => {
  it("validates and removes the carrier before workflow loading", () => {
    const environment: NodeJS.ProcessEnv = {
      [traceCarrierEnvironment]: JSON.stringify({
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value",
      }),
    };

    expect(captureTraceCarrierEnvironment(environment)).toEqual({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    });
    expect(environment).not.toHaveProperty(traceCarrierEnvironment);
  });

  it("removes a malformed carrier before rejecting startup", () => {
    const environment: NodeJS.ProcessEnv = {
      [traceCarrierEnvironment]: "{}",
    };

    expect(() => captureTraceCarrierEnvironment(environment)).toThrow(
      "Invalid trace carrier",
    );
    expect(environment).not.toHaveProperty(traceCarrierEnvironment);
  });
});
