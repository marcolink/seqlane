// @test-scope ./model-capabilities.ts
import { describe, expect, it } from "vitest";
import { CodexRequestDeadlineError } from "./deadline.js";
import { createCodexModelCapabilities } from "./model-capabilities.js";
import type { CodexTransport } from "./transport.js";

describe("Codex model capabilities", () => {
  it("caches a validated model list and closes its discovery transport", async () => {
    const requests: string[] = [];
    let closed = 0;
    let initializeTimeoutMs: number | undefined;
    const capabilities = createCodexModelCapabilities(
      {
        executable: "/opt/codex",
        workspace: "/workspace",
        networkAccess: false,
      },
      {
        createTransport: async (_configuration, options) => {
          initializeTimeoutMs = options?.initializeTimeoutMs;
          return {
            request: async (method: string) => {
              requests.push(method);
              return {
                data: [
                  {
                    id: "openai/gpt-5.6-codex",
                    model: "gpt-5.6-codex",
                    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
                    isDefault: true,
                  },
                ],
              };
            },
            close: async () => {
              closed += 1;
            },
          } as unknown as CodexTransport;
        },
      },
    );

    await expect(capabilities.listModels()).resolves.toEqual([
      { provider: "openai", model: "gpt-5.6-codex" },
    ]);
    await expect(capabilities.resolveDefaultModel()).resolves.toEqual({
      model: { provider: "openai", model: "gpt-5.6-codex" },
    });
    expect(requests).toEqual(["model/list"]);
    expect(closed).toBe(1);
    expect(initializeTimeoutMs).toBe(15_000);
  });

  it("bounds an unresponsive model discovery request and closes its transport", async () => {
    let closed = 0;
    const capabilities = createCodexModelCapabilities(
      {
        executable: "/opt/codex",
        workspace: "/workspace",
        networkAccess: false,
      },
      {
        requestTimeoutMs: 10,
        createTransport: async () =>
          ({
            request: async () => new Promise<never>(() => undefined),
            close: async () => {
              closed += 1;
            },
          }) as unknown as CodexTransport,
      },
    );

    await expect(capabilities.listModels()).rejects.toBeInstanceOf(
      CodexRequestDeadlineError,
    );
    expect(closed).toBe(1);
  });

  it("bounds transport creation and closes a transport that resolves late", async () => {
    let closed = 0;
    let closeCalled!: () => void;
    const closeCalledPromise = new Promise<void>((resolve) => {
      closeCalled = resolve;
    });
    let resolveTransport!: (transport: CodexTransport) => void;
    const capabilities = createCodexModelCapabilities(
      {
        executable: "/opt/codex",
        workspace: "/workspace",
        networkAccess: false,
      },
      {
        requestTimeoutMs: 10,
        createTransport: () =>
          new Promise<CodexTransport>((resolve) => {
            resolveTransport = resolve;
          }),
      },
    );

    await expect(capabilities.listModels()).rejects.toBeInstanceOf(
      CodexRequestDeadlineError,
    );
    resolveTransport({
      request: async () => ({ data: [] }),
      close: async () => {
        closed += 1;
        closeCalled();
      },
    } as unknown as CodexTransport);
    await closeCalledPromise;
    expect(closed).toBe(1);
  });
});
