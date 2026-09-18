// @test-scope ./runtime.ts
import { describe, expect, it } from "vitest";
import { createCodexAgentRuntimeFactory } from "./runtime.js";

describe("Codex agent runtime composition", () => {
  it("creates one run-scoped runtime with matching adapter capabilities", async () => {
    const factory = createCodexAgentRuntimeFactory({
      adapter: "codex",
      executable: "/opt/codex",
      networkAccess: false,
    });
    const runtime = await factory(
      new AbortController().signal,
      "/workspace-from-composition",
    );
    const adapter = runtime.createAdapter({
      signal: new AbortController().signal,
    });

    expect(runtime).toMatchObject({
      identity: "codex",
      capabilities: {
        execute: true,
        modelSelection: true,
        checkpoint: true,
        fork: true,
      },
    });
    expect(adapter.capabilities).toEqual(runtime.capabilities);
    await runtime.close?.();
  });

  it("requires composition to supply a workspace", async () => {
    const factory = createCodexAgentRuntimeFactory({
      adapter: "codex",
      executable: "/opt/codex",
    });

    await expect(
      factory(new AbortController().signal, undefined),
    ).rejects.toThrow("Codex requires a workspace");
  });
});
