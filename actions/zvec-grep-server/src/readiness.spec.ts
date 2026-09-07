import { describe, expect, it } from "vitest";
import { buildReadinessArguments, mcpUrl } from "./readiness.js";

describe("zvec-grep readiness", () => {
  it("binds readiness to the configured instance home", () => {
    expect(
      buildReadinessArguments("@zvec/zvec-grep@0.2.1", "/tmp/zvec-grep"),
    ).toEqual([
      "dlx",
      "@zvec/zvec-grep@0.2.1",
      "server",
      "status",
      "--check-ready",
      "--home",
      "/tmp/zvec-grep",
    ]);
  });

  it("builds the MCP endpoint from the configured listen address", () => {
    expect(mcpUrl("127.0.0.1:7999")).toBe("http://127.0.0.1:7999/mcp");
  });
});
