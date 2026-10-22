// @test-scope ./system-one-client.ts
// @test-scope ./system-one-operation.ts
// @test-scope ./system-one-retry.ts

import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { SeqlaneObservation } from "@seqlane/protocol";
import {
  CLASSIFIER_TRANSPORT_BUDGET_MS,
  SystemOneClient,
} from "./system-one-client.js";
import { retryDelayFor } from "./system-one-retry.js";
import {
  classifierRequest as request,
  classifierResponseBody as responseBody,
} from "./system-one-client-fixtures.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("System One retry policy", () => {
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

  it.each([
    { value: "1", delayMs: 1_000 },
    { value: "-1", delayMs: 200 },
    { value: "Thu, 24 Sep 2026 10:00:03 GMT", delayMs: 3_000 },
    { value: "Thursday, 24-Sep-26 10:00:03 GMT", delayMs: 3_000 },
    { value: "Thu Sep 24 10:00:03 2026", delayMs: 3_000 },
    {
      value: "Thu Sep  3 10:00:03 2026",
      requestAt: "2026-09-03T10:00:00.000Z",
      delayMs: 3_000,
    },
    { value: "Mon, 31 Feb 2025 10:00:03 GMT", delayMs: 200 },
    { value: "Mon, 24 Sep 2026 10:00:03 GMT", delayMs: 200 },
    { value: "not an HTTP date", delayMs: 200 },
  ])(
    "uses a valid Retry-After minimum and falls back for invalid value $value",
    async ({ value, requestAt, delayMs }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(requestAt ?? "2026-09-24T10:00:00.000Z"));
      let requests = 0;
      const client = new SystemOneClient(
        { url: "https://localhost/v1/systemone", model: "jev-latest" },
        async () => {
          requests += 1;
          if (requests !== 1) {
            return new Response(JSON.stringify(responseBody), { status: 200 });
          }
          return new Response("busy", {
            status: 429,
            headers: { "retry-after": value },
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
    },
  );

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
    const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
    let requests = 0;
    const observations: SeqlaneObservation[] = [];
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let respond!: (response: Response) => void;
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => {
        requests += 1;
        started();
        return new Promise<Response>((resolve) => {
          respond = resolve;
        });
      },
      clock,
    );

    const classification = client.classify(
      request,
      new AbortController().signal,
      (observation) => observations.push(observation),
    );
    await fetchStarted;
    await Effect.runPromise(clock.adjust(19_500));
    respond(
      new Response("busy", {
        status: 429,
        headers: { "retry-after": "1" },
      }),
    );
    await expect(classification).rejects.toMatchObject({ code: "transport" });
    expect(requests).toBe(1);
    expect(observations).toHaveLength(1);
    expect(retryDelayFor(0, "1", Date.now(), 500)).toBeUndefined();
  });

  it("preserves the last attempt failure when the deadline expires in backoff", async () => {
    vi.useFakeTimers();
    let requests = 0;
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => {
        requests += 1;
        return new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response("busy", { status: 429 })),
            19_800,
          );
        });
      },
    );
    const classification = client.classify(
      request,
      new AbortController().signal,
      (observation) => {
        observations.push(observation);
      },
    );
    const assertion = expect(classification).rejects.toMatchObject({
      code: "deadline",
      cause: expect.objectContaining({
        code: "transport",
        message: expect.stringContaining("HTTP 429"),
      }),
    });

    await vi.advanceTimersByTimeAsync(19_800);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(requests).toBe(1);
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
    vi.useFakeTimers();
    const observations: SeqlaneObservation[] = [];
    let bodySent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!bodySent) {
          bodySent = true;
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(responseBody)),
          );
        }
      },
    });
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => new Response(body, { status: 200 }),
    );

    const classification = client.classify(
      request,
      new AbortController().signal,
      (observation) => observations.push(observation),
    );
    const assertion = expect(classification).rejects.toMatchObject({
      code: "deadline",
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
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
});
