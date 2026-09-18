// @test-scope ./runtime.ts
import type { AgentAdapter } from "@seqlane/agent-adapter";
import { describe, expect, it, vi } from "vitest";
import { createAcpAdapter } from "./adapter.js";
import { createAcpAgentRuntimeFactory } from "./runtime.js";

vi.mock("./adapter.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./adapter.js")>();
  return { ...original, createAcpAdapter: vi.fn(original.createAcpAdapter) };
});

const capabilities = {
  execute: true,
  modelSelection: false,
  structuredOutput: true,
  sessionReuse: false,
  checkpoint: false,
  fork: false,
  activity: false,
  sessionUi: false,
} as const;

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
      requestContext: undefined,
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

  it("redacts synchronous adapter-construction failures", async () => {
    vi.mocked(createAcpAdapter).mockImplementationOnce(() => {
      throw new Error("could not launch secret-argument");
    });
    const factory = createAcpAgentRuntimeFactory({
      adapter: "acp",
      configuration: {
        id: "controlled-acp",
        description: "Controlled ACP runtime",
        command: process.execPath,
        args: ["secret-argument"],
        persistSession: false,
      },
    });
    const runtime = await factory(new AbortController().signal, undefined);

    expect(() =>
      runtime.createAdapter({
        signal: new AbortController().signal,
        requestContext: undefined,
      }),
    ).toThrow("could not launch [REDACTED]");
  });

  it("does not treat empty launch arguments or environment values as secrets", async () => {
    const factory = createAcpAgentRuntimeFactory({
      adapter: "acp",
      configuration: {
        id: "controlled-acp",
        description: "Controlled ACP runtime",
        command: process.execPath,
        args: [""],
        env: { EMPTY_VALUE: "" },
        persistSession: false,
      },
    });
    const runtime = await factory(new AbortController().signal, undefined);
    const adapter: AgentAdapter = {
      capabilities,
      execute: async () => undefined,
      close: async () => {
        throw new Error("connection failed");
      },
    };

    await expect(runtime.redactAdapter(adapter).close?.()).rejects.toThrow(
      "connection failed",
    );
  });
});
