// @test-scope ./structured-output.ts
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { extractStructuredOutput } from "./index.js";

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const assistantMessage = (sessionID: string) => ({
  id: "message-1",
  sessionID,
  role: "assistant",
  time: { created: 1, completed: 2 },
  parentID: "message-0",
  modelID: "fake-model",
  providerID: "fake-provider",
  mode: "build",
  agent: "build",
  path: { cwd: "/repo", root: "/repo" },
  cost: 0,
  tokens: {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
  structured: { supported: true },
});

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? undefined : JSON.parse(text);
}

function writeJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startFakeServer(
  options: { readonly structured: boolean } = { structured: true },
) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = request.url ?? "/";
    requests.push({ method: request.method ?? "", path, body });

    if (request.method === "POST" && path === "/session") {
      writeJson(response, 200, {
        id: "session-1",
        projectID: "project-1",
        directory: "/repo",
        title: "Seqlane contract",
        version: "1",
        time: { created: 1, updated: 1 },
      });
      return;
    }

    if (request.method === "POST" && path === "/session/session-1/message") {
      writeJson(response, 200, {
        info: options.structured
          ? assistantMessage("session-1")
          : { ...assistantMessage("session-1"), structured: undefined },
        parts: [],
      });
      return;
    }

    if (request.method === "POST" && path === "/session/session-1/abort") {
      writeJson(response, 200, true);
      return;
    }

    writeJson(response, 404, { name: "NotFoundError", data: {} });
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

describe("OpenCode public SDK/server contract", () => {
  it("supports session creation, schema-backed output, final result, and abort", async () => {
    const fake = await startFakeServer();
    try {
      const client = createOpencodeClient({ baseUrl: fake.url });
      const session = await client.session.create({}, { throwOnError: true });
      const result = await client.session.prompt(
        {
          sessionID: session.data.id,
          parts: [{ type: "text", text: "Return the contract result." }],
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { supported: { type: "boolean" } },
              required: ["supported"],
            },
            retryCount: 0,
          },
        },
        { throwOnError: true },
      );
      const aborted = await client.session.abort(
        { sessionID: session.data.id },
        { throwOnError: true },
      );

      expect(session.data.id).toBe("session-1");
      expect(extractStructuredOutput(result.data)).toEqual({ supported: true });
      expect(aborted.data).toBe(true);
      expect(fake.requests.map(({ path }) => path)).toEqual([
        "/session",
        "/session/session-1/message",
        "/session/session-1/abort",
      ]);
      expect(fake.requests[1]?.body).toMatchObject({
        format: { type: "json_schema" },
      });
    } finally {
      await closeServer(fake.server);
    }
  });

  it("does not treat a text-only response as structured output", async () => {
    const fake = await startFakeServer({ structured: false });
    try {
      const client = createOpencodeClient({ baseUrl: fake.url });
      const response = await client.session.prompt(
        {
          sessionID: "session-1",
          parts: [{ type: "text", text: "Return a result." }],
          format: { type: "json_schema", schema: { type: "object" } },
        },
        { throwOnError: true },
      );

      expect(() => extractStructuredOutput(response.data)).toThrow(
        "did not contain structured output",
      );
      expect(response.data.parts).toEqual([]);
    } finally {
      await closeServer(fake.server);
    }
  });
});
