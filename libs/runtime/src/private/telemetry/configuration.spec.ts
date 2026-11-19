import { describe, expect, it } from "vitest";
import {
  captureTelemetryConfigurationEnvironment,
  decodeTelemetryConfiguration,
  encodeTelemetryConfiguration,
  TelemetryConfigurationError,
  telemetryConfigurationEnvironment,
} from "./configuration.js";

describe("private telemetry configuration", () => {
  it("keeps export disabled without explicit configuration", () => {
    expect(captureTelemetryConfigurationEnvironment({})).toBeUndefined();
  });

  it("round-trips explicit metadata and full policies with bounded defaults", () => {
    for (const payloadPolicy of ["metadata", "full"]) {
      const value = decodeTelemetryConfiguration(
        JSON.stringify({
          endpoint: "http://127.0.0.1:4318/collector?tenant=one",
          payloadPolicy,
          headers: { Authorization: "Bearer secret" },
        }),
      );
      expect(value).toEqual({
        endpoint: "http://127.0.0.1:4318/collector?tenant=one",
        payloadPolicy,
        headers: { Authorization: "Bearer secret" },
        maxPendingBytes: 4 * 1024 * 1024,
        shutdownTimeoutMs: 5_000,
      });
      expect(
        decodeTelemetryConfiguration(encodeTelemetryConfiguration(value)),
      ).toEqual(value);
    }
  });

  it("removes configuration credentials before returning the accepted value", () => {
    const environment: NodeJS.ProcessEnv = {
      KEEP: "present",
      [telemetryConfigurationEnvironment]: JSON.stringify({
        endpoint: "https://collector.example/otlp",
        payloadPolicy: "metadata",
        headers: { Authorization: "Bearer secret" },
        maxPendingBytes: 1_024,
        shutdownTimeoutMs: 100,
      }),
    };
    expect(captureTelemetryConfigurationEnvironment(environment)).toMatchObject(
      {
        payloadPolicy: "metadata",
        maxPendingBytes: 1_024,
        shutdownTimeoutMs: 100,
      },
    );
    expect(environment).toEqual({ KEEP: "present" });
  });

  it.each([
    '{"headers":"Bearer secret',
    "null",
    "[]",
    JSON.stringify({ endpoint: "http://localhost:4318" }),
    JSON.stringify({
      endpoint: "file:///tmp/collector",
      payloadPolicy: "full",
    }),
    JSON.stringify({
      endpoint: "https://user:secret@collector.example",
      payloadPolicy: "full",
    }),
    JSON.stringify({
      endpoint: "https://collector.example/#fragment",
      payloadPolicy: "full",
    }),
    JSON.stringify({
      endpoint: "https://collector.example",
      payloadPolicy: "unknown",
    }),
    JSON.stringify({
      endpoint: "https://collector.example",
      payloadPolicy: "full",
      extra: true,
    }),
    JSON.stringify({
      endpoint: "https://collector.example",
      payloadPolicy: "full",
      maxPendingBytes: 0,
    }),
    JSON.stringify({
      endpoint: "https://collector.example",
      payloadPolicy: "full",
      maxPendingBytes: 64 * 1024 * 1024 + 1,
    }),
    JSON.stringify({
      endpoint: "https://collector.example",
      payloadPolicy: "full",
      shutdownTimeoutMs: 30_001,
    }),
    JSON.stringify({
      endpoint: "https://collector.example",
      payloadPolicy: "full",
      headers: { "bad\nname": "secret" },
    }),
    JSON.stringify({
      endpoint: "https://collector.example",
      payloadPolicy: "full",
      headers: { Authorization: "secret\r\ninjected: value" },
    }),
    JSON.stringify({
      endpoint: "https://collector.example",
      payloadPolicy: "full",
      headers: Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`header-${i}`, "secret"]),
      ),
    }),
    " ".repeat(64 * 1024 + 1),
  ])(
    "rejects invalid configuration without retaining secret parser diagnostics",
    (encoded) => {
      const environment = { [telemetryConfigurationEnvironment]: encoded };
      let error: unknown;
      try {
        captureTelemetryConfigurationEnvironment(environment);
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(TelemetryConfigurationError);
      expect(error).toMatchObject({
        message: "Invalid telemetry configuration",
        code: "telemetry-configuration",
      });
      expect(String(error)).not.toContain("secret");
      expect(environment).toEqual({});
    },
  );
});
