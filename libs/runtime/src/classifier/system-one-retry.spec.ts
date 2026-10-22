// @test-scope ./system-one-client.ts
// @test-scope ./system-one-operation.ts
// @test-scope ./system-one-retry.ts

import { describe, expect, it } from "vitest";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
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
} from "./system-one-client-test-support.js";

function classify(
  client: SystemOneClient,
  observations: SeqlaneObservation[] = [],
  signal = new AbortController().signal,
) {
  return client.classify(request, signal, (observation) =>
    observations.push(observation),
  );
}

const connection = {
  url: "https://localhost/v1/systemone",
  model: "jev-latest",
};
const success = () =>
  new Response(JSON.stringify(responseBody), { status: 200 });

describe("System One retry policy", () => {
  it.each([429, 529, 500, 503, 599])(
    "retries transient HTTP status %s",
    async (status) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          let requests = 0;
          const client = new SystemOneClient(connection, async () =>
            ++requests === 1
              ? new Response("temporary", { status })
              : success(),
          );
          const fiber = yield* classify(client).pipe(Effect.forkChild);
          yield* TestClock.adjust(199);
          expect(requests).toBe(1);
          yield* TestClock.adjust(1);
          expect(yield* Fiber.join(fiber)).toMatchObject({
            model: "jev-1.13.0",
          });
          expect(requests).toBe(2);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    },
  );

  it("retries a network failure with the same request and exchange identity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let requests = 0;
        const observations: SeqlaneObservation[] = [];
        const client = new SystemOneClient(connection, async () => {
          if (++requests === 1) throw new Error("socket closed before headers");
          return success();
        });
        const fiber = yield* classify(client, observations).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust(200);
        expect(yield* Fiber.join(fiber)).toMatchObject({ model: "jev-1.13.0" });
        expect(requests).toBe(2);
        expect(observations.map(({ attemptIndex }) => attemptIndex)).toEqual([
          0, 1,
        ]);
        expect(observations[0]?.observationId).toBe(
          observations[1]?.observationId,
        );
        expect(observations.map(({ state }) => state)).toEqual([
          "failed",
          "succeeded",
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it.each([400, 401, 403, 404, 422])(
    "does not retry nonretryable HTTP status %s",
    async (status) => {
      let requests = 0;
      const client = new SystemOneClient(connection, async () => {
        requests += 1;
        return new Response("not retryable", { status });
      });
      await expect(
        Effect.runPromise(
          classify(client).pipe(Effect.provide(TestClock.layer())),
        ),
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
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(
            Date.parse(requestAt ?? "2026-09-24T10:00:00.000Z"),
          );
          let requests = 0;
          const client = new SystemOneClient(connection, async () =>
            ++requests === 1
              ? new Response("busy", {
                  status: 429,
                  headers: { "retry-after": value },
                })
              : success(),
          );
          const fiber = yield* classify(client).pipe(Effect.forkChild);
          yield* TestClock.adjust(delayMs - 1);
          expect(requests).toBe(1);
          yield* TestClock.adjust(1);
          expect(yield* Fiber.join(fiber)).toMatchObject({
            model: "jev-1.13.0",
          });
          expect(requests).toBe(2);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    },
  );

  it("stops after four attempts and records each failure under one observation ID", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let requests = 0;
        const observations: SeqlaneObservation[] = [];
        const client = new SystemOneClient(connection, async () => {
          requests += 1;
          return new Response("unavailable", { status: 503 });
        });
        const fiber = yield* classify(client, observations).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust(1_400);
        expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({
          code: "transport",
          message: "Classifier endpoint returned HTTP 503",
        });
        expect(requests).toBe(4);
        expect(observations).toHaveLength(4);
        expect(observations.map(({ attemptIndex }) => attemptIndex)).toEqual([
          0, 1, 2, 3,
        ]);
        expect(
          new Set(observations.map(({ observationId }) => observationId)).size,
        ).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it.each([
    { elapsed: 19_500, retryAfter: "1" },
    { elapsed: 19_800, retryAfter: "0" },
  ])(
    "does not retry when Retry-After cannot fit the remaining budget ($elapsed)",
    async ({ elapsed, retryAfter }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          let requests = 0;
          const observations: SeqlaneObservation[] = [];
          const response = yield* Deferred.make<Response>();
          const client = new SystemOneClient(connection, async () => {
            requests += 1;
            return Effect.runPromise(Deferred.await(response));
          });
          const fiber = yield* classify(client, observations).pipe(
            Effect.forkChild,
          );
          yield* TestClock.adjust(elapsed);
          yield* Deferred.succeed(
            response,
            new Response("busy", {
              status: 429,
              headers: { "retry-after": retryAfter },
            }),
          );
          expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({
            code: "transport",
          });
          expect(requests).toBe(1);
          expect(observations).toHaveLength(1);
          expect(retryDelayFor(0, "1", 0, 500)).toBeUndefined();
        }).pipe(Effect.provide(TestClock.layer())),
      );
    },
  );

  it("preserves the last attempt failure when the deadline expires during a retry", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let requests = 0;
        const observations: SeqlaneObservation[] = [];
        const response = yield* Deferred.make<Response>();
        const client = new SystemOneClient(connection, async (_url, init) => {
          requests += 1;
          if (requests > 1)
            return new Promise<Response>((_resolve, reject) =>
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true },
              ),
            );
          return Effect.runPromise(Deferred.await(response));
        });
        const fiber = yield* classify(client, observations).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust(19_799);
        yield* Deferred.succeed(
          response,
          new Response("busy", { status: 429 }),
        );
        yield* TestClock.adjust(201);
        expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({
          code: "deadline",
          cause: expect.objectContaining({
            code: "transport",
            message: expect.stringContaining("HTTP 429"),
          }),
        });
        expect(requests).toBe(2);
        expect(observations).toHaveLength(2);
        expect(observations[0]).toMatchObject({
          state: "failed",
          attemptIndex: 0,
        });
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it("stops backoff when the caller aborts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const controller = new AbortController();
        const cancellation = new Error("caller cancelled");
        const observations: SeqlaneObservation[] = [];
        let requests = 0;
        const client = new SystemOneClient(connection, async () => {
          requests += 1;
          return new Response("busy", { status: 429 });
        });
        const fiber = yield* classify(
          client,
          observations,
          controller.signal,
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust(50);
        controller.abort(cancellation);
        expect(yield* Effect.flip(Fiber.join(fiber))).toBe(cancellation);
        expect(requests).toBe(1);
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({
          state: "failed",
          attemptIndex: 0,
        });
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it("lets caller cancellation win when it races with a provider response", async () => {
    const controller = new AbortController();
    const cancellation = new Error("caller cancelled");
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient(
      connection,
      async (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal === null || signal === undefined)
            return reject(new Error("request signal missing"));
          signal.addEventListener("abort", () => resolve(success()), {
            once: true,
          });
        }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* classify(
          client,
          observations,
          controller.signal,
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust(50);
        controller.abort(cancellation);
        expect(yield* Effect.flip(Fiber.join(fiber))).toBe(cancellation);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      state: "cancelled",
      attemptIndex: 0,
    });
  });

  it("preserves native interruption and aborts the in-flight HTTP request", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const controller = new AbortController();
        let aborted = false;
        const observations: SeqlaneObservation[] = [];
        const client = new SystemOneClient(
          connection,
          async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(init.signal?.reason);
                },
                { once: true },
              );
              Deferred.doneUnsafe(started, Effect.void);
            }),
        );
        const fiber = yield* classify(
          client,
          observations,
          controller.signal,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
        ).toBe(true);
        expect(aborted).toBe(true);
        expect(controller.signal.aborted).toBe(false);
        expect(observations).toHaveLength(1);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it("enforces the transport deadline while the response body is read", async () => {
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
      connection,
      async () => new Response(body, { status: 200 }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* classify(client, observations).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust(20_000);
        expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({
          code: "deadline",
        });
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ state: "failed", attemptIndex: 0 });
  });

  it.each([0, 1])(
    "aborts a pending request within the shared budget after %s retries",
    async (retries) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          let requests = 0;
          let aborted = false;
          const observations: SeqlaneObservation[] = [];
          const response = yield* Deferred.make<Response>();
          const client = new SystemOneClient(connection, async (_url, init) => {
            requests += 1;
            if (requests <= retries)
              return Effect.runPromise(Deferred.await(response));
            return new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal;
              if (signal === null || signal === undefined)
                return reject(new Error("request signal missing"));
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(signal.reason);
                },
                { once: true },
              );
            });
          });
          const fiber = yield* classify(client, observations).pipe(
            Effect.forkChild,
          );
          if (retries > 0) {
            yield* TestClock.adjust(10_000);
            yield* Deferred.succeed(
              response,
              new Response("busy", { status: 503 }),
            );
          }
          yield* TestClock.adjust(
            CLASSIFIER_TRANSPORT_BUDGET_MS - (retries > 0 ? 10_000 : 0),
          );
          expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({
            code: "deadline",
            ...(retries === 0
              ? {}
              : {
                  cause: expect.objectContaining({
                    code: "transport",
                    message: "Classifier endpoint returned HTTP 503",
                  }),
                }),
          });
          expect(aborted).toBe(true);
          expect(requests).toBe(retries + 1);
          expect(observations).toHaveLength(retries + 1);
          expect(observations[retries]).toMatchObject({
            state: "failed",
            attemptIndex: retries,
          });
        }).pipe(Effect.provide(TestClock.layer())),
      );
    },
  );
});
