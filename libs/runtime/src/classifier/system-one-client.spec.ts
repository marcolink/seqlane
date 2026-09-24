// @test-scope ./system-one-client.ts
// @test-scope ./payload-limits.ts
// @test-scope ./system-one-observation.ts
// @test-scope ./system-one-retry.ts

import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassifierRequest, JsonValue } from "@seqlane/core";
import type { SeqlaneObservation } from "@seqlane/protocol";
import {
  CLASSIFIER_TRANSPORT_BUDGET_MS,
  SystemOneClient,
} from "./system-one-client.js";
import {
  CLASSIFIER_MAX_INSTRUCTIONS_BYTES,
  CLASSIFIER_MAX_STATE_BYTES,
} from "./payload-limits.js";
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

const mixedRequest: ClassifierRequest = {
  state: { diff: "example diff" },
  questions: {
    area: {
      kind: "choice",
      instructions: "Which area should review this diff?",
      criteria: { security: "Security", runtime: "Runtime" },
    },
    priority: {
      kind: "score",
      instructions: "How urgent is review?",
      criteria: ["Low", "High"],
    },
    needsReview: {
      kind: "noul",
      instructions: "Does this diff need review?",
    },
  },
};

const mixedResponseBody = {
  model: "jev-1.13.0",
  answers: {
    area: {
      type: "choice",
      choice: "runtime",
      probabilities: { security: 0.2, runtime: 0.8 },
      confidence: 0.8,
      note: "choice extension",
    },
    priority: {
      type: "score",
      score: 0.8,
      legend: { "0": "Low", "1": "High" },
      probabilities: { "0": 0.2, "1": 0.8 },
      confidence: 0.8,
    },
    needsReview: { type: "noul", noul: 0.63 },
  },
  usage: { input_tokens: 14, output_tokens: 7 },
};

const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
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
      model: " jev-latest ",
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

  it("retries a 429 through HTTP and emits indexed observations for one exchange", async () => {
    const requestBodies: string[] = [];
    let requests = 0;
    const fixture = await listen((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        requests += 1;
        requestBodies.push(Buffer.concat(chunks).toString("utf8"));
        if (requests === 1) {
          outgoing.writeHead(429, { "retry-after": "0" });
          outgoing.end("busy");
          return;
        }
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(responseBody));
      });
    });
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient({
      url: fixture.url,
      model: "jev-latest",
    });

    const result = await client.classify(
      request,
      new AbortController().signal,
      (observation) => observations.push(observation),
    );

    expect(result.model).toBe("jev-1.13.0");
    expect(requests).toBe(2);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(observations).toHaveLength(2);
    expect(observations.map(({ attemptIndex }) => attemptIndex)).toEqual([
      0, 1,
    ]);
    expect(observations[0]?.observationId).toBe(observations[1]?.observationId);
    expect(observations).toMatchObject([
      {
        state: "failed",
        model: {
          request: JSON.parse(requestBodies[0] ?? "{}"),
          error: expect.stringContaining("HTTP 429"),
        },
      },
      {
        state: "succeeded",
        model: {
          request: JSON.parse(requestBodies[1] ?? "{}"),
          response: responseBody,
        },
      },
    ]);
  });

  it.each([429, 529, 500, 503, 599])(
    "retries transient HTTP status %s",
    async (status) => {
      vi.useFakeTimers();
      let requests = 0;
      const client = new SystemOneClient(
        { url: "https://localhost/v1/systemone", model: "jev-latest" },
        async () => {
          requests += 1;
          return requests === 1
            ? new Response("temporary", { status })
            : new Response(JSON.stringify(responseBody), { status: 200 });
        },
      );
      const classification = client.classify(
        request,
        new AbortController().signal,
        () => undefined,
      );
      const assertion = expect(classification).resolves.toMatchObject({
        model: "jev-1.13.0",
      });

      await vi.advanceTimersByTimeAsync(200);
      await assertion;
      expect(requests).toBe(2);
    },
  );

  it("retries a network failure with the same request and exchange identity", async () => {
    vi.useFakeTimers();
    let requests = 0;
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => {
        requests += 1;
        if (requests === 1) throw new Error("socket closed before headers");
        return new Response(JSON.stringify(responseBody), { status: 200 });
      },
    );
    const classification = client.classify(
      request,
      new AbortController().signal,
      (observation) => observations.push(observation),
    );
    const assertion = expect(classification).resolves.toMatchObject({
      model: "jev-1.13.0",
    });

    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(requests).toBe(2);
    expect(observations.map(({ attemptIndex }) => attemptIndex)).toEqual([
      0, 1,
    ]);
    expect(observations[0]?.observationId).toBe(observations[1]?.observationId);
    expect(observations[0]?.state).toBe("failed");
    expect(observations[1]?.state).toBe("succeeded");
  });

  it.each([400, 401, 403, 404, 422])(
    "does not retry nonretryable HTTP status %s",
    async (status) => {
      vi.useFakeTimers();
      let requests = 0;
      const client = new SystemOneClient(
        { url: "https://localhost/v1/systemone", model: "jev-latest" },
        async () => {
          requests += 1;
          return new Response("not retryable", { status });
        },
      );

      await expect(
        client.classify(request, new AbortController().signal, () => undefined),
      ).rejects.toMatchObject({ code: "transport" });
      expect(requests).toBe(1);
    },
  );

  it("uses Retry-After seconds and HTTP dates as backoff minimums", async () => {
    vi.useFakeTimers();
    const cases: readonly (() => {
      readonly value: string;
      readonly delayMs: number;
    })[] = [
      () => ({ value: "1", delayMs: 1_000 }),
      () => ({ value: "-1", delayMs: 200 }),
      () => {
        const requestedAt = Date.now();
        const value = new Date(requestedAt + 2_500).toUTCString();
        return {
          value,
          delayMs: Math.max(200, Date.parse(value) - requestedAt),
        };
      },
    ];

    for (const createRetryAfter of cases) {
      let requests = 0;
      let delayMs = 0;
      const client = new SystemOneClient(
        { url: "https://localhost/v1/systemone", model: "jev-latest" },
        async () => {
          requests += 1;
          if (requests !== 1) {
            return new Response(JSON.stringify(responseBody), { status: 200 });
          }
          const retryAfter = createRetryAfter();
          delayMs = retryAfter.delayMs;
          return new Response("busy", {
            status: 429,
            headers: { "retry-after": retryAfter.value },
          });
        },
      );
      const classification = client.classify(
        request,
        new AbortController().signal,
        () => undefined,
      );
      const assertion = expect(classification).resolves.toMatchObject({
        model: "jev-1.13.0",
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(requests).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(requests).toBe(2);
    }
  });

  it("stops after four attempts and records each failure under one observation ID", async () => {
    vi.useFakeTimers();
    let requests = 0;
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => {
        requests += 1;
        return new Response("unavailable", { status: 503 });
      },
    );
    const classification = client.classify(
      request,
      new AbortController().signal,
      (observation) => observations.push(observation),
    );
    const assertion = expect(classification).rejects.toMatchObject({
      code: "transport",
      message: "Classifier endpoint returned HTTP 503",
    });

    await vi.advanceTimersByTimeAsync(1_400);
    await assertion;
    expect(requests).toBe(4);
    expect(observations).toHaveLength(4);
    expect(observations.map(({ attemptIndex }) => attemptIndex)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(
      new Set(observations.map(({ observationId }) => observationId)).size,
    ).toBe(1);
  });

  it("does not retry when Retry-After cannot fit the remaining budget", async () => {
    let now = 0;
    let requests = 0;
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => {
        requests += 1;
        now = CLASSIFIER_TRANSPORT_BUDGET_MS - 500;
        return new Response("busy", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      },
      () => now,
    );

    await expect(
      client.classify(request, new AbortController().signal, (observation) =>
        observations.push(observation),
      ),
    ).rejects.toMatchObject({ code: "transport" });
    expect(requests).toBe(1);
    expect(observations).toHaveLength(1);
  });

  it("preserves the last attempt failure when the deadline expires in backoff", async () => {
    vi.useFakeTimers();
    let now = 0;
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => new Response("busy", { status: 429 }),
      () => now,
    );
    const classification = client.classify(
      request,
      new AbortController().signal,
      (observation) => {
        observations.push(observation);
        setTimeout(() => {
          now = CLASSIFIER_TRANSPORT_BUDGET_MS;
        }, 100);
      },
    );
    const assertion = expect(classification).rejects.toMatchObject({
      code: "deadline",
      cause: expect.objectContaining({
        code: "transport",
        message: expect.stringContaining("HTTP 429"),
      }),
    });

    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ state: "failed", attemptIndex: 0 });
  });

  it("stops backoff when the caller aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancellation = new Error("caller cancelled");
    const observations: SeqlaneObservation[] = [];
    let requests = 0;
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => {
        requests += 1;
        return new Response("busy", { status: 429 });
      },
    );
    const classification = client.classify(
      request,
      controller.signal,
      (observation) => {
        observations.push(observation);
        setTimeout(() => controller.abort(cancellation), 50);
      },
    );
    const assertion = expect(classification).rejects.toBe(cancellation);

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(requests).toBe(1);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ state: "failed", attemptIndex: 0 });
  });

  it("lets caller cancellation win when it races with a provider response", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancellation = new Error("caller cancelled");
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const requestSignal = init?.signal;
          if (requestSignal === null || requestSignal === undefined) {
            reject(new Error("request signal missing"));
            return;
          }
          requestSignal.addEventListener(
            "abort",
            () =>
              resolve(
                new Response(JSON.stringify(responseBody), { status: 200 }),
              ),
            { once: true },
          );
          setTimeout(() => controller.abort(cancellation), 50);
        }),
    );
    const classification = client.classify(
      request,
      controller.signal,
      (observation) => observations.push(observation),
    );
    const assertion = expect(classification).rejects.toBe(cancellation);

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      state: "cancelled",
      attemptIndex: 0,
    });
  });

  it("enforces the transport deadline while the response body is read", async () => {
    let now = 0;
    const observations: SeqlaneObservation[] = [];
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          now = CLASSIFIER_TRANSPORT_BUDGET_MS - 1;
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(responseBody)),
          );
          return;
        }
        now = CLASSIFIER_TRANSPORT_BUDGET_MS;
        controller.close();
      },
    });
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => new Response(body, { status: 200 }),
      () => now,
    );

    await expect(
      client.classify(request, new AbortController().signal, (observation) =>
        observations.push(observation),
      ),
    ).rejects.toMatchObject({ code: "deadline" });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ state: "failed", attemptIndex: 0 });
  });

  it("aborts a pending request when the shared 20-second budget expires", async () => {
    vi.useFakeTimers();
    let requests = 0;
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          requests += 1;
          const requestSignal = init?.signal;
          if (requestSignal === null || requestSignal === undefined) {
            reject(new Error("request signal missing"));
            return;
          }
          requestSignal.addEventListener(
            "abort",
            () => reject(requestSignal.reason),
            { once: true },
          );
        }),
    );
    const classification = client.classify(
      request,
      new AbortController().signal,
      (observation) => observations.push(observation),
    );
    const assertion = expect(classification).rejects.toMatchObject({
      code: "deadline",
    });

    await vi.advanceTimersByTimeAsync(CLASSIFIER_TRANSPORT_BUDGET_MS);
    await assertion;
    expect(requests).toBe(1);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ state: "failed", attemptIndex: 0 });
  });

  it("rejects deeply nested and oversized state before it sends a request", async () => {
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
    await expect(
      client.classify(
        { ...request, state: "x".repeat(CLASSIFIER_MAX_STATE_BYTES + 1) },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "request" });
    expect(requests).toBe(0);
  });

  it("rejects an oversized aggregate request before recursive question validation", async () => {
    let requests = 0;
    const questions = Object.fromEntries(
      Array.from({ length: 17 }, (_value, index) => [
        `question${index}`,
        {
          kind: "noul" as const,
          instructions:
            index === 0 ? "" : "x".repeat(CLASSIFIER_MAX_INSTRUCTIONS_BYTES),
        },
      ]),
    );
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => {
        requests += 1;
        return new Response(JSON.stringify(responseBody), { status: 200 });
      },
    );

    await expect(
      client.classify(
        { state: "example diff", questions },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "request",
      message: expect.stringContaining("request body exceeds the byte"),
    });
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

  it("sends and maps Choice, Score, and Noul in one request", async () => {
    let capturedBody = "";
    const fixture = await listen((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        capturedBody = Buffer.concat(chunks).toString("utf8");
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(mixedResponseBody));
      });
    });
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient({
      url: fixture.url,
      model: "jev-latest",
    });

    const result = await client.classify(
      mixedRequest,
      new AbortController().signal,
      (observation) => observations.push(observation),
    );

    expect(JSON.parse(capturedBody)).toEqual({
      model: "jev-latest",
      state: { diff: "example diff" },
      questions: {
        area: {
          type: "choice",
          instructions: "Which area should review this diff?",
          criteria: { security: "Security", runtime: "Runtime" },
        },
        priority: {
          type: "score",
          instructions: "How urgent is review?",
          criteria: ["Low", "High"],
        },
        needsReview: {
          type: "noul",
          instructions: "Does this diff need review?",
        },
      },
    });
    expect(result).toEqual({
      model: "jev-1.13.0",
      answers: {
        area: {
          kind: "choice",
          selected: "runtime",
          probabilities: { security: 0.2, runtime: 0.8 },
          confidence: 0.8,
          extensions: { note: "choice extension" },
        },
        priority: {
          kind: "score",
          value: 0.8,
          legend: { "0": "Low", "1": "High" },
          probabilities: { "0": 0.2, "1": 0.8 },
          confidence: 0.8,
        },
        needsReview: { kind: "noul", probability: 0.63 },
      },
      usage: { inputTokens: 14, outputTokens: 7 },
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      kind: "model",
      state: "succeeded",
      model: {
        operation: "classifier",
        request: JSON.parse(capturedBody),
        response: mixedResponseBody,
      },
    });
  });

  it("reports a mismatched answer as a typed failure before success observation", async () => {
    const invalidResponse = {
      ...mixedResponseBody,
      answers: {
        ...mixedResponseBody.answers,
        area: { ...mixedResponseBody.answers.area, choice: "billing" },
      },
    };
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () =>
        new Response(JSON.stringify(invalidResponse), { status: 200 }),
    );

    await expect(
      client.classify(mixedRequest, new AbortController().signal, (event) =>
        observations.push(event),
      ),
    ).rejects.toMatchObject({ code: "response" });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      kind: "model",
      state: "failed",
      attemptIndex: 0,
      model: {
        operation: "classifier",
        error: expect.stringContaining("response"),
      },
    });
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
    vi.useFakeTimers();
    const apiKey = "transport-private-key";
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient(
      { url: "https://jev.example/v1/systemone", model: "jev-latest", apiKey },
      async () => {
        throw new Error(`network failure ${apiKey}`);
      },
    );

    const classification = client.classify(
      request,
      new AbortController().signal,
      (observation) => observations.push(observation),
    );
    const errorPromise = classification.catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(1_400);
    const error = await errorPromise;
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
    expect(observations).toHaveLength(4);
    expect(JSON.stringify(observations)).not.toContain(apiKey);
  });

  it("retains harmless transport causes", async () => {
    vi.useFakeTimers();
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
    const classification = client.classify(
      request,
      new AbortController().signal,
      () => undefined,
    );
    const errorPromise = classification.catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(1_400);
    const error = await errorPromise;

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

  it.each(["key", "model", "noul"])(
    "allows credential %s to collide with ordinary protocol data",
    async (apiKey) => {
      let requests = 0;
      const client = new SystemOneClient(
        {
          url: "https://jev.example/v1/systemone",
          model: "monkey-model",
          apiKey,
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
    },
  );

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
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      kind: "model",
      state: "failed",
      model: { operation: "classifier", provider: "typesafe" },
    });
    expect(JSON.stringify(observations)).not.toContain(apiKey);
  });

  it("emits one failed observation for each provider failure phase", async () => {
    const fixtures: readonly {
      readonly phase: string;
      readonly code: string;
      readonly fetchImplementation: typeof fetch;
    }[] = [
      {
        phase: "malformed response",
        code: "response",
        fetchImplementation: async () =>
          new Response("{invalid", { status: 200 }),
      },
      {
        phase: "mapping",
        code: "response",
        fetchImplementation: async () =>
          new Response(
            JSON.stringify({
              ...responseBody,
              answers: { extra: { type: "noul", noul: 0.5 } },
            }),
            { status: 200 },
          ),
      },
    ];

    for (const fixture of fixtures) {
      const observations: SeqlaneObservation[] = [];
      const client = new SystemOneClient(
        { url: "https://localhost/v1/systemone", model: "jev-latest" },
        fixture.fetchImplementation,
      );
      const error = await client
        .classify(request, new AbortController().signal, (observation) =>
          observations.push(observation),
        )
        .catch((cause: unknown) => cause);

      expect(error, fixture.phase).toMatchObject({ code: fixture.code });
      expect(observations, fixture.phase).toHaveLength(1);
      expect(observations[0], fixture.phase).toMatchObject({
        kind: "model",
        state: "failed",
        attemptIndex: 0,
        model: {
          operation: "classifier",
          provider: "typesafe",
          model: "jev-latest",
          request: expect.any(Object),
          error: expect.stringContaining(fixture.code),
        },
      });
    }
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
    const successfulClient = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => new Response(JSON.stringify(responseBody), { status: 200 }),
    );

    await expect(
      successfulClient.classify(request, new AbortController().signal, () => {
        throw sinkFailure;
      }),
    ).rejects.toBe(sinkFailure);

    const failedClient = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => {
        throw new Error("socket closed");
      },
    );
    await expect(
      failedClient.classify(request, new AbortController().signal, () => {
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
