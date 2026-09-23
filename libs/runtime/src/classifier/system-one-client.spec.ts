// @test-scope ./system-one-client.ts
// @test-scope ./payload-limits.ts

import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { ClassifierRequest, JsonValue } from "@seqlane/core";
import {
  CLASSIFIER_TRANSPORT_BUDGET_MS,
  SystemOneClient,
} from "./system-one-client.js";
import { ClassifierFailure } from "./types.js";

const request: ClassifierRequest = {
  state: "example diff",
  questions: {
    needsReview: {
      kind: "noul",
      instructions: "Does this diff need review?",
    },
  },
};

const responseBody = {
  model: "jev-1.13.0",
  answers: {
    needsReview: {
      type: "noul",
      noul: 0.63,
      answer_note: "fixture-extension",
    },
  },
  usage: { input_tokens: 10, output_tokens: 2, cached_tokens: 4 },
  request_trace: { fixture: true },
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }),
  );
});

async function listen(
  handler: RequestListener,
): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture did not bind a TCP port");
  }
  return { server, url: `http://127.0.0.1:${address.port}/v1/systemone` };
}

describe("System One client", () => {
  it("sends the fixed Noul request and emits one bounded credential-free observation", async () => {
    const apiKey = "fixture-private-key";
    let capturedBody = "";
    let capturedAuthorization: string | undefined;
    const fixture = await listen((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        capturedBody = Buffer.concat(chunks).toString("utf8");
        capturedAuthorization = incoming.headers.authorization;
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(responseBody));
      });
    });
    const observations: unknown[] = [];
    const client = new SystemOneClient({
      url: fixture.url,
      model: "jev-latest",
      apiKey,
    });

    const result = await client.classify(
      request,
      new AbortController().signal,
      (observation) => observations.push(observation),
    );

    expect(capturedAuthorization).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(capturedBody)).toEqual({
      model: "jev-latest",
      state: "example diff",
      questions: {
        needsReview: {
          type: "noul",
          instructions: "Does this diff need review?",
        },
      },
    });
    expect(result).toEqual({
      model: "jev-1.13.0",
      answers: {
        needsReview: {
          kind: "noul",
          probability: 0.63,
          extensions: { answer_note: "fixture-extension" },
        },
      },
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        extensions: { cached_tokens: 4 },
      },
      extensions: { request_trace: { fixture: true } },
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      kind: "model",
      state: "succeeded",
      attemptIndex: 0,
      model: {
        operation: "classifier",
        model: "jev-1.13.0",
        request: JSON.parse(capturedBody),
        response: responseBody,
        usage: responseBody.usage,
      },
    });
    expect(JSON.stringify(observations)).not.toContain(apiKey);
  });

  it("rejects complex state before it sends a request", async () => {
    let requests = 0;
    const fixture = await listen((_incoming, outgoing) => {
      requests += 1;
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(responseBody));
    });
    let nested: JsonValue = "leaf";
    for (let index = 0; index < 64; index += 1) nested = { child: nested };
    const deepRequest = { ...request, state: nested };
    const client = new SystemOneClient({
      url: fixture.url,
      model: "jev-latest",
    });

    await expect(
      client.classify(
        deepRequest,
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "request" });
    expect(requests).toBe(0);
  });

  it("uses only loopback HTTP and disables redirects without exposing the key", async () => {
    const apiKey = "fixture-redirect-key";
    let redirectedRequests = 0;
    const target = await listen((_incoming, outgoing) => {
      redirectedRequests += 1;
      outgoing.writeHead(200);
      outgoing.end(JSON.stringify(responseBody));
    });
    const source = await listen((_incoming, outgoing) => {
      outgoing.writeHead(302, { location: target.url });
      outgoing.end();
    });
    const client = new SystemOneClient({
      url: source.url,
      model: "jev-latest",
      apiKey,
    });

    const error = await client
      .classify(request, new AbortController().signal, () => undefined)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClassifierFailure);
    expect(String(error)).not.toContain(apiKey);
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(
      JSON.stringify({
        message: (error as Error).message,
        cause: (error as Error & { cause?: unknown }).cause,
      }),
    ).not.toContain(apiKey);
    expect(redirectedRequests).toBe(0);
  });

  it("rejects Choice and Score until their System One mapping is delivered", async () => {
    let requests = 0;
    const client = new SystemOneClient(
      { url: "https://jev.example/v1/systemone", model: "jev-latest" },
      async () => {
        requests += 1;
        return new Response(JSON.stringify(responseBody), { status: 200 });
      },
    );
    const choiceRequest = {
      state: "example diff",
      questions: {
        needsReview: {
          kind: "choice" as const,
          instructions: "Which area should review this diff?",
          criteria: { security: "Security", runtime: "Runtime" },
        },
      },
    };

    await expect(
      client.classify(
        choiceRequest,
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "unsupported-kind" });
    expect(requests).toBe(0);
  });

  it("allows an HTTPS loopback endpoint without a token", async () => {
    let requests = 0;
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => {
        requests += 1;
        return new Response(JSON.stringify(responseBody), { status: 200 });
      },
    );

    const result = await client.classify(
      request,
      new AbortController().signal,
      () => undefined,
    );
    expect(requests).toBe(1);
    expect(result.answers.needsReview).toMatchObject({
      kind: "noul",
      probability: 0.63,
    });
  });

  it("keeps transport causes private when the original error includes the key", async () => {
    const apiKey = "transport-private-key";
    const client = new SystemOneClient(
      { url: "https://jev.example/v1/systemone", model: "jev-latest", apiKey },
      async () => {
        throw new Error(`network failure ${apiKey}`);
      },
    );

    const error = await client
      .classify(request, new AbortController().signal, () => undefined)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClassifierFailure);
    expect(String(error)).not.toContain(apiKey);
    expect(JSON.stringify(error)).not.toContain(apiKey);
    const failureCause = (error as Error & { cause?: unknown }).cause;
    expect(failureCause).toBeInstanceOf(Error);
    expect(String(failureCause)).toBe(
      "Error: Classifier transport cause redacted",
    );
    expect(
      JSON.stringify({
        message: (error as Error).message,
        cause: failureCause,
      }),
    ).not.toContain(apiKey);
  });

  it("retains harmless transport causes", async () => {
    const client = new SystemOneClient(
      {
        url: "https://jev.example/v1/systemone",
        model: "jev-latest",
        apiKey: "fixture-safe-cause-key",
      },
      async () => {
        throw new Error("socket closed before headers");
      },
    );
    const error = await client
      .classify(request, new AbortController().signal, () => undefined)
      .catch((cause: unknown) => cause);

    expect((error as Error & { cause?: unknown }).cause).toMatchObject({
      message: "socket closed before headers",
    });
    expect(
      JSON.stringify({
        message: (error as Error).message,
        cause: (error as Error & { cause?: unknown }).cause,
      }),
    ).not.toContain("fixture-safe-cause-key");
  });

  it("allows credentials that are substrings of ordinary request data", async () => {
    let requests = 0;
    const client = new SystemOneClient(
      {
        url: "https://jev.example/v1/systemone",
        model: "monkey-model",
        apiKey: "key",
      },
      async () => {
        requests += 1;
        return new Response(JSON.stringify(responseBody), { status: 200 });
      },
    );

    await expect(
      client.classify(
        { ...request, state: "keyboard change" },
        new AbortController().signal,
        () => undefined,
      ),
    ).resolves.toMatchObject({ model: "jev-1.13.0" });
    expect(requests).toBe(1);
  });

  it("rejects credentials encoded in parsed response values", async () => {
    const apiKey = "secret-key";
    const escapedResponse =
      '{"model":"jev-1.13.0","answers":{"needsReview":{"type":"noul","noul":0.63,"answer_note":"secret\\u002dkey"}},"usage":{"input_tokens":10,"output_tokens":2}}';
    expect(escapedResponse).not.toContain(apiKey);
    const observations: unknown[] = [];
    const client = new SystemOneClient(
      { url: "https://jev.example/v1/systemone", model: "jev-latest", apiKey },
      async () => new Response(escapedResponse, { status: 200 }),
    );

    await expect(
      client.classify(request, new AbortController().signal, (observation) =>
        observations.push(observation),
      ),
    ).rejects.toMatchObject({ code: "response" });
    expect(observations).toHaveLength(0);
  });

  it("enforces the deadline after observation delivery", async () => {
    let now = 0;
    const observations: unknown[] = [];
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => new Response(JSON.stringify(responseBody), { status: 200 }),
      () => now,
    );

    await expect(
      client.classify(request, new AbortController().signal, (observation) => {
        observations.push(observation);
        now = CLASSIFIER_TRANSPORT_BUDGET_MS;
      }),
    ).rejects.toMatchObject({ code: "deadline" });
    expect(observations).toHaveLength(1);
  });

  it("propagates observation sink failures unchanged", async () => {
    const sinkFailure = new Error("observation sink failed");
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => new Response(JSON.stringify(responseBody), { status: 200 }),
    );

    await expect(
      client.classify(request, new AbortController().signal, () => {
        throw sinkFailure;
      }),
    ).rejects.toBe(sinkFailure);
  });

  it("rejects malformed and oversized responses with a safe typed failure", async () => {
    const malformed = await listen((_incoming, outgoing) => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end("{invalid");
    });
    const client = new SystemOneClient({
      url: malformed.url,
      model: "jev-latest",
    });
    await expect(
      client.classify(request, new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({ code: "response" });
  });
});
