// @test-scope ./runtime.ts
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createOpenCodeAgentRuntimeFactory } from "./runtime.js";

const capabilityErrorMessage =
  "OpenCode capability failed at https://example.test/path%2Fsecret?credential=query%2Fsecret#credential=fragment%2Fsecret (decoded: /path/secret query/secret fragment/secret; raw values: query%2Fsecret fragment%2Fsecret)";

vi.mock("./model-capabilities.js", () => ({
  createOpenCodeModelCapabilities: () => ({
    executor: "opencode",
    listModels: async () => {
      throw capabilityError();
    },
    resolveDefaultModel: async () => {
      throw capabilityError();
    },
    validateModelSelection: async () => {
      throw capabilityError();
    },
  }),
}));

function capabilityError(): Error & {
  readonly code: string;
  readonly details: { readonly message: string };
} {
  return Object.assign(
    new Error(capabilityErrorMessage, {
      cause: new Error(capabilityErrorMessage),
    }),
    {
      code: "OPENCODE_TEST_ERROR",
      details: { message: capabilityErrorMessage },
    },
  );
}

async function startBrowserUiServer(): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("OpenCode browser UI fixture has no TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

describe("OpenCode agent runtime composition", () => {
  it("discovers the browser UI and creates an adapter with matching capabilities", async () => {
    const browserUi = await startBrowserUiServer();
    try {
      const factory = createOpenCodeAgentRuntimeFactory({
        adapter: "opencode",
        url: browserUi.url,
      });
      const runtime = await factory(
        new AbortController().signal,
        "/workspace-from-composition",
      );
      const adapter = runtime.createAdapter({
        signal: new AbortController().signal,
      });

      expect(runtime).toMatchObject({
        identity: "opencode",
        capabilities: {
          execute: true,
          modelSelection: true,
          checkpoint: true,
          fork: true,
          sessionUi: true,
        },
      });
      expect(adapter.capabilities).toEqual(runtime.capabilities);
    } finally {
      await browserUi.close();
    }
  });

  it("rejects a runtime URL with embedded credentials", () => {
    expect(() =>
      createOpenCodeAgentRuntimeFactory({
        adapter: "opencode",
        url: "https://token@example.test",
      }),
    ).toThrow(/embedded credentials/i);
  });

  it.each([
    [
      "lists models",
      (
        runtime: Awaited<
          ReturnType<ReturnType<typeof createOpenCodeAgentRuntimeFactory>>
        >,
      ) => runtime.modelCapabilities?.listModels(),
    ],
    [
      "resolves the default model",
      (
        runtime: Awaited<
          ReturnType<ReturnType<typeof createOpenCodeAgentRuntimeFactory>>
        >,
      ) => runtime.modelCapabilities?.resolveDefaultModel(),
    ],
    [
      "validates model selection",
      (
        runtime: Awaited<
          ReturnType<ReturnType<typeof createOpenCodeAgentRuntimeFactory>>
        >,
      ) =>
        runtime.modelCapabilities?.validateModelSelection?.({
          model: { provider: "openai", model: "gpt-5.6" },
        }),
    ],
  ])("redacts connection secrets when it %s", async (_name, operation) => {
    const browserUi = await startBrowserUiServer();
    try {
      const factory = createOpenCodeAgentRuntimeFactory({
        adapter: "opencode",
        url: `${browserUi.url}/path%2Fsecret?credential=query%2Fsecret#credential=fragment%2Fsecret`,
      });
      const runtime = await factory(new AbortController().signal, undefined);
      const result = operation(runtime);
      if (result === undefined) throw new Error("Model capability is missing");
      const error = await result.catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: "OPENCODE_TEST_ERROR" });
      const serialized = JSON.stringify(
        error,
        Object.getOwnPropertyNames(error),
      );
      for (const secret of [
        "path%2Fsecret",
        "query%2Fsecret",
        "fragment%2Fsecret",
        "path/secret",
        "query/secret",
        "fragment/secret",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      await browserUi.close();
    }
  });

  it("does not treat a root URL path as a secret", async () => {
    const browserUi = await startBrowserUiServer();
    try {
      const factory = createOpenCodeAgentRuntimeFactory({
        adapter: "opencode",
        url: browserUi.url,
      });
      const runtime = await factory(new AbortController().signal, undefined);
      const error = await runtime.modelCapabilities
        ?.listModels()
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(capabilityErrorMessage);
    } finally {
      await browserUi.close();
    }
  });
});
