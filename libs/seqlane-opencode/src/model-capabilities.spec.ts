// @test-scope ./model-capabilities.ts
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createOpenCodeModelCapabilities } from "./model-capabilities.js";

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startFakeServer(options: {
  readonly providerResponse: unknown;
  readonly configResponse: unknown;
}) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "/");
    if (request.method === "GET" && request.url === "/provider") {
      writeJson(response, options.providerResponse);
      return;
    }
    if (request.method === "GET" && request.url === "/config/providers") {
      writeJson(response, options.configResponse);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake OpenCode server did not expose a TCP address");
  }

  return {
    requests,
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

const providerCatalog = {
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Sonnet" },
        "claude-haiku-4-5": { id: "claude-haiku-4-5", name: "Haiku" },
      },
    },
    {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-5.6-luna": { id: "gpt-5.6-luna", name: "Luna" },
      },
    },
  ],
  default: {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-5.6-luna",
  },
};

const providerList = {
  all: providerCatalog.providers,
  default: providerCatalog.default,
  connected: ["anthropic", "openai"],
};

describe("OpenCode model capabilities", () => {
  it("lists configured models and resolves the configured default", async () => {
    const fake = await startFakeServer({
      providerResponse: providerList,
      configResponse: providerCatalog,
    });
    try {
      const capabilities = createOpenCodeModelCapabilities(fake.url);

      await expect(capabilities.listModels()).resolves.toEqual([
        { provider: "anthropic", model: "claude-sonnet-4-6" },
        { provider: "anthropic", model: "claude-haiku-4-5" },
        { provider: "openai", model: "gpt-5.6-luna" },
      ]);
      await expect(capabilities.resolveDefaultModel()).resolves.toEqual({
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });

      expect(capabilities.executor).toBe("opencode");
      expect(fake.requests).toEqual(["/provider", "/config/providers"]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("rejects a catalog with a malformed model entry", async () => {
    const fake = await startFakeServer({
      providerResponse: {
        all: [
          {
            id: "anthropic",
            models: { "claude-sonnet-4-6": { name: "Sonnet" } },
          },
        ],
        default: { anthropic: "claude-sonnet-4-6" },
        connected: ["anthropic"],
      },
      configResponse: providerCatalog,
    });
    try {
      const capabilities = createOpenCodeModelCapabilities(fake.url);

      await expect(capabilities.listModels()).rejects.toThrow();
    } finally {
      await closeServer(fake.server);
    }
  });

  it("rejects a default that is not present in the configured catalog", async () => {
    const fake = await startFakeServer({
      providerResponse: providerList,
      configResponse: {
        ...providerCatalog,
        default: { anthropic: "missing-model" },
      },
    });
    try {
      const capabilities = createOpenCodeModelCapabilities(fake.url);

      await expect(capabilities.resolveDefaultModel()).rejects.toThrow(
        'OpenCode default model "anthropic/missing-model" is not in its configured catalog',
      );
    } finally {
      await closeServer(fake.server);
    }
  });
});
