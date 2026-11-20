import { describe, expect, it } from "vitest";
import { createRunAdapterConfiguration } from "./adapter-flags.js";

describe("V2 CLI flag configuration", () => {
  it("accepts a shared executable path for automatic detection", () => {
    expect(
      JSON.parse(
        createRunAdapterConfiguration({
          adapter: "opencode",
          "opencode-executable": "/opt/opencode",
        }) ?? "null",
      ),
    ).toMatchObject({ adapter: "opencode", executable: "/opt/opencode" });
  });

  it.each([
    { "opencode-executable": "opencode" },
    {
      "opencode-mode": "external",
      "opencode-host": "127.0.0.1",
      "opencode-port": 4096,
      "opencode-executable": "/opt/opencode",
    },
  ])("rejects an invalid automatic executable selection", (flags) => {
    expect(() =>
      createRunAdapterConfiguration({ adapter: "opencode", ...flags }),
    ).toThrow();
  });
  it("keeps V1 and V2 identities separate", () => {
    expect(createRunAdapterConfiguration({ adapter: "opencode" })).toBe(
      '{"adapter":"opencode","mode":"managed","host":"127.0.0.1","port":0}',
    );
    expect(createRunAdapterConfiguration({ adapter: "opencode-v2" })).toBe(
      '{"adapter":"opencode-v2","mode":"managed","host":"127.0.0.1","port":0}',
    );
    expect(createRunAdapterConfiguration({})).toBeUndefined();
  });
  it("preserves the explicit V2 endpoint and executable", () => {
    expect(
      JSON.parse(
        createRunAdapterConfiguration({
          adapter: "opencode-v2",
          "opencode-v2-executable": "/opt/opencode-v2",
          "opencode-v2-host": "localhost",
        }) ?? "null",
      ),
    ).toMatchObject({
      adapter: "opencode-v2",
      host: "127.0.0.1",
      executable: "/opt/opencode-v2",
    });
  });
  it.each([
    { "opencode-v2-mode": "external" },
    {
      "opencode-v2-mode": "external",
      "opencode-v2-host": "127.0.0.1",
      "opencode-v2-port": 0,
    },
    { "opencode-v2-host": "0.0.0.0" },
    { "opencode-v2-executable": "opencode" },
    {
      "opencode-v2-mode": "external",
      "opencode-v2-host": "127.0.0.1",
      "opencode-v2-port": 4096,
      "opencode-v2-executable": "/opt/opencode",
    },
  ])("rejects invalid V2 configuration", (flags) => {
    expect(() =>
      createRunAdapterConfiguration({ adapter: "opencode-v2", ...flags }),
    ).toThrow();
  });
});
