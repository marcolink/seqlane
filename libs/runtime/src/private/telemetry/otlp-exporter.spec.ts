// @test-scope ./otlp-exporter.ts
// @test-scope ./otlp-projection.ts
// @test-scope ./otlp-acknowledgement.ts
import { Effect } from "effect";
import { createServer } from "node:http";
import { TestClock } from "effect/testing";
import { jsonValueSchema } from "@seqlane/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telemetryConfigurationSchema } from "./configuration.js";
import { exportTelemetry } from "./otlp-exporter.js";
import type { TelemetrySpan } from "./collector.js";

const traceId = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";
function span(
  attributes: Readonly<Record<string, unknown>> = {},
): TelemetrySpan {
  return {
    name: "model.generate",
    traceId,
    spanId,
    startTime: 1,
    endTime: 2,
    status: "ended",
    attributes,
  };
}
function log(body = "run.started") {
  return {
    timestamp: "2026-10-21T10:00:00.000Z",
    severity: "INFO" as const,
    body,
    traceId,
    attributes: { "event.type": "run.started" },
  };
}
function configuration(options = {}) {
  return telemetryConfigurationSchema.parse({
    endpoint: "https://collector.example/base?tenant=one",
    payloadPolicy: "full",
    shutdownTimeoutMs: 500,
    ...options,
  });
}
function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  throw new Error("Expected an encoded OTLP JSON body");
}
function bodyDocument(body: BodyInit | null | undefined) {
  const value: unknown = JSON.parse(bodyText(body));
  return jsonValueSchema.parse(value);
}

afterEach(() => vi.unstubAllGlobals());

describe("bounded native OTLP exporter", () => {
  it("sends complete values, identities, source times, and links to native signal endpoints", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const payload = {
      request: {
        prompt: "complete",
        values: [false, 0, "", null, [], { text: "é".repeat(1_000) }],
      },
    };
    const result = await exportTelemetry(
      configuration({ headers: { authorization: "Bearer test" } }),
      {
        spans: [
          {
            ...span({ "seqlane.observation": payload }),
            startTimeUnixNano: "1000001",
            endTimeUnixNano: "2000002",
            links: [{ traceId, spanId: "2222222222222222" }],
          },
        ],
        logs: [log()],
        metrics: [
          {
            name: "seqlane.invocations",
            value: 1,
            attributes: { outcome: "succeeded" },
          },
          {
            name: "seqlane.event_queue.pending_bytes_peak",
            value: 12,
            attributes: {},
            kind: "gauge",
          },
        ],
      },
    );
    expect(result).toEqual({
      failed: false,
      droppedRecords: 0,
      exportFailures: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://collector.example/base/v1/traces?tenant=one",
      "https://collector.example/base/v1/logs?tenant=one",
      "https://collector.example/base/v1/metrics?tenant=one",
    ]);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test");
    expect(init?.redirect).toBe("error");
    expect(bodyDocument(fetchMock.mock.calls[2]?.[1]?.body)).toMatchObject({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "seqlane.invocations",
                  sum: { isMonotonic: true },
                },
                {
                  name: "seqlane.event_queue.pending_bytes_peak",
                  gauge: { dataPoints: [{ asInt: "12" }] },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(bodyDocument(init?.body)).toMatchObject({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId,
                  startTimeUnixNano: "1000001",
                  endTimeUnixNano: "2000002",
                  links: [{ traceId, spanId: "2222222222222222" }],
                  attributes: [
                    {
                      key: "seqlane.observation",
                      value: { stringValue: JSON.stringify(payload) },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(
      fetchMock.mock.calls.every(
        ([, request]) =>
          Buffer.byteLength(bodyText(request?.body)) <= 4 * 1024 * 1024,
      ),
    ).toBe(true);
  });

  it("keeps metadata policy free of canonical request and response payloads", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null));
    vi.stubGlobal("fetch", fetchMock);
    const result = await exportTelemetry(
      configuration({ payloadPolicy: "metadata" }),
      {
        spans: [
          span({
            "seqlane.observation.id": "observation",
            "seqlane.observation": { request: "private prompt" },
            "seqlane.activity": { output: "private output" },
            "seqlane.event": { input: "private input" },
          }),
        ],
        logs: [],
        metrics: [],
      },
    );
    expect(result).toEqual({
      failed: false,
      droppedRecords: 0,
      exportFailures: 0,
    });
    const text = bodyText(fetchMock.mock.calls[0]?.[1]?.body);
    expect(text).toContain("observation.id");
    expect(text).not.toContain("private");
  });

  it("omits whole oversized records between valid records and bounds every in-flight body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null));
    vi.stubGlobal("fetch", fetchMock);
    const source = Array.from({ length: 8 }, (_, i) =>
      span({ "seqlane.observation": { index: i, value: "é".repeat(100) } }),
    );
    source.splice(
      3,
      0,
      span({ "seqlane.observation": { oversized: "x".repeat(10_000) } }),
    );
    const result = await exportTelemetry(
      configuration({ maxPendingBytes: 1_600 }),
      { spans: source, logs: [], metrics: [] },
    );
    expect(result).toEqual({
      failed: false,
      droppedRecords: 1,
      exportFailures: 0,
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const text = fetchMock.mock.calls.map(([, init]) => bodyText(init?.body));
    expect(text.every((body) => Buffer.byteLength(body) <= 1_600)).toBe(true);
    expect(text.join("")).not.toContain("oversized");
    for (let i = 0; i < 8; i += 1)
      expect(text.join("")).toContain(`\\"index\\":${i}`);
  });

  it("does not invent a terminal timestamp for an unfinished span", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null));
    vi.stubGlobal("fetch", fetchMock);
    const { endTime: _endTime, ...started } = span();
    const result = await exportTelemetry(configuration(), {
      spans: [{ ...started, status: "started" }],
      logs: [],
      metrics: [],
    });
    expect(result).toEqual({
      failed: false,
      droppedRecords: 1,
      exportFailures: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a whole malformed native attribute without salvaging fields", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await exportTelemetry(configuration(), {
        spans: [
          span({
            "seqlane.observation": { accepted: false, unsupported: () => 1 },
          }),
        ],
        logs: [],
        metrics: [],
      }),
    ).toEqual({ failed: true, droppedRecords: 0, exportFailures: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/metrics");
  });

  it.each([503, 401])(
    "reports HTTP %s and exports the failure count with healthy later signals",
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      expect(
        await exportTelemetry(configuration(), {
          spans: [span()],
          logs: [log()],
          metrics: [{ name: "seqlane.invocations", value: 1, attributes: {} }],
        }),
      ).toEqual({ failed: true, droppedRecords: 0, exportFailures: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v1/logs");
      expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/v1/metrics");
      expect(bodyText(fetchMock.mock.calls[2]?.[1]?.body)).toContain(
        "seqlane.telemetry.export_failures",
      );
      expect(bodyText(fetchMock.mock.calls[2]?.[1]?.body)).toContain(
        '"key":"signal","value":{"stringValue":"traces"}',
      );
    },
  );

  it.each([
    { partialSuccess: { rejectedSpans: "1", errorMessage: "rejected" } },
    { partialSuccess: { rejectedLogRecords: 2 } },
    { partialSuccess: { rejectedDataPoints: "3" } },
  ])("reports collector partial rejection %j", async (response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response))),
    );
    expect(
      await exportTelemetry(configuration(), {
        spans: [span()],
        logs: [],
        metrics: [],
      }),
    ).toEqual({ failed: true, droppedRecords: 0, exportFailures: 2 });
  });

  it.each(["malformed", "x".repeat(64 * 1024 + 1)])(
    "rejects malformed or oversized collector acknowledgements",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response(body)),
      );
      expect(
        await exportTelemetry(configuration(), {
          spans: [span()],
          logs: [],
          metrics: [],
        }),
      ).toEqual({ failed: true, droppedRecords: 0, exportFailures: 2 });
    },
  );

  it("shares one shutdown deadline across signal batches and aborts the in-flight request", async () => {
    const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
    let firstStarted!: () => void;
    const first = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondStarted!: () => void;
    const second = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let respond!: (value: Response) => void;
    let aborted = false;
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        requests += 1;
        if (requests === 1) {
          firstStarted();
          return new Promise<Response>((resolve) => {
            respond = resolve;
          });
        }
        secondStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        });
      }),
    );
    const result = exportTelemetry(
      configuration({ shutdownTimeoutMs: 100 }),
      { spans: [span()], logs: [log()], metrics: [] },
      clock,
    );
    await first;
    await Effect.runPromise(clock.adjust(60));
    respond(new Response(null));
    await second;
    await Effect.runPromise(clock.adjust(40));
    expect(await result).toEqual({
      failed: true,
      droppedRecords: 0,
      exportFailures: 1,
    });
    expect(requests).toBe(2);
    expect(aborted).toBe(true);
  });

  it("cancels a blocked response body within the total shutdown deadline", async () => {
    const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {
                bodyStarted();
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      ),
    );
    const result = exportTelemetry(
      configuration({ shutdownTimeoutMs: 100 }),
      { spans: [span()], logs: [], metrics: [] },
      clock,
    );
    await started;
    await Effect.runPromise(clock.adjust(100));
    expect(await result).toEqual({
      failed: true,
      droppedRecords: 0,
      exportFailures: 1,
    });
    expect(cancelled).toBe(true);
  });

  it("closes the real HTTP response when collector acknowledgement stalls", async () => {
    const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
    let headersSent!: () => void;
    const started = new Promise<void>((resolve) => {
      headersSent = resolve;
    });
    let peerClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      peerClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.resume();
      response.on("close", peerClosed);
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      headersSent();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Expected TCP collector address");
      const result = exportTelemetry(
        configuration({
          endpoint: `http://127.0.0.1:${address.port}`,
          shutdownTimeoutMs: 100,
        }),
        { spans: [span()], logs: [], metrics: [] },
        clock,
      );
      await started;
      await Effect.runPromise(clock.adjust(100));
      expect(await result).toEqual({
        failed: true,
        droppedRecords: 0,
        exportFailures: 1,
      });
      await closed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
