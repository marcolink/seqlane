// @test-scope ./runtime.ts
import { describe, expect, it } from "vitest";
import { createAcpAgentRuntimeFactory } from "./runtime.js";

describe("ACP agent runtime composition", () => {
  it("validates ACP configuration and creates an adapter with matching capabilities", async () => {
    const factory = createAcpAgentRuntimeFactory({
      adapter: "acp",
      configuration: {
        id: "controlled-acp",
        description: "Controlled ACP runtime",
        command: process.execPath,
        persistSession: true,
      },
    });

    const runtime = await factory(new AbortController().signal, undefined);
    const adapter = runtime.createAdapter({
      signal: new AbortController().signal,
    });

    expect(runtime).toMatchObject({
      identity: "acp",
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: true,
      },
    });
    expect(adapter.capabilities).toEqual(runtime.capabilities);
  });

  it("rejects an incomplete ACP composition configuration", () => {
    expect(() =>
      createAcpAgentRuntimeFactory({
        adapter: "acp",
        configuration: { id: "missing-command" },
      }),
    ).toThrow();
  });
});
