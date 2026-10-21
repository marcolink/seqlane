import { describe, expect, it } from "vitest";
import { createRunAdapterConfiguration } from "./adapter-flags.js";

describe("V2 CLI flag configuration", () => {
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
