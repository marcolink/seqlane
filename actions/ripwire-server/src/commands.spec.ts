// @test-scope ./commands.ts

import { describe, expect, it } from "vitest";
import { buildRipwireArguments, buildRipwireEnvironment } from "./commands.js";
import { parseRipwireInputs } from "./config.js";

const config = parseRipwireInputs({ workingDirectory: "/tmp/project" });

describe("Ripwire command construction", () => {
  it("constructs the default command with no unsafe flags", () => {
    expect(buildRipwireArguments(config)).toEqual([
      "/tmp/project",
      "--listen=127.0.0.1:7998",
      "--top-k=200",
    ]);
  });

  it("adds explicit opt-out flags and never puts the token in argv", () => {
    const configured = parseRipwireInputs({
      workingDirectory: "/tmp/project",
      listen: "0.0.0.0:7998",
      topK: "0",
      stableOrder: "false",
      redact: "false",
      mcpToken: "secret",
      allowRemoteEdits: "true",
    });
    expect(buildRipwireArguments(configured)).toEqual([
      "/tmp/project",
      "--listen=0.0.0.0:7998",
      "--top-k=0",
      "--no-stable",
      "--no-redact",
      "--allow-remote-edits",
    ]);
    expect(buildRipwireArguments(configured).join(" ")).not.toContain("secret");
  });

  it("adds the trusted binary directory to PATH and isolates an unset token", () => {
    expect(
      buildRipwireEnvironment(
        {
          PATH: "/usr/bin",
          RIPWIRE_MCP_TOKEN: "inherited",
          "INPUT_MCP-TOKEN": "raw-action-input",
        },
        "/tmp/ripwire-install",
        undefined,
      ),
    ).toEqual({ PATH: "/tmp/ripwire-install:/usr/bin" });
    expect(
      buildRipwireEnvironment(
        { PATH: "/usr/bin", "INPUT_MCP-TOKEN": "raw-action-input" },
        "/tmp/ripwire-install",
        "secret",
      ),
    ).toMatchObject({
      RIPWIRE_MCP_TOKEN: "secret",
      PATH: "/tmp/ripwire-install:/usr/bin",
    });
    expect(
      buildRipwireEnvironment(
        { PATH: "/usr/bin", "INPUT_MCP-TOKEN": "raw-action-input" },
        "/tmp/ripwire-install",
        "secret",
      ),
    ).not.toHaveProperty("INPUT_MCP-TOKEN");
  });
});
