// @test-scope ./event-body.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";

const encoder = new TextEncoder();
const synced = 'data: {"type":"log.synced","aggregateID":"ses_test"}\n\n';

function response(chunks: string[], status = 200, cancel = vi.fn()) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
      cancel,
    }),
    { status, headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("V2 streaming transport", () => {
  it("delivers an event before the response closes and cancels its reader", async () => {
    const cancel = vi.fn();
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                source = controller;
                controller.enqueue(encoder.encode(synced));
              },
              cancel,
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const iterator = createClient("http://fixture")
      .session.log({ sessionID: "ses_test", follow: true })
      [Symbol.asyncIterator]();
    try {
      await expect(
        Promise.race([
          iterator.next(),
          new Promise((resolve) => setTimeout(() => resolve("buffered"), 100)),
        ]).then((value) => {
          if (value === "buffered") source?.close();
          return value;
        }),
      ).resolves.toMatchObject({ value: { type: "log.synced" } });
    } finally {
      await iterator.return?.();
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("accepts more than 1 MiB of separate frames in one network chunk", async () => {
    const count = 24_000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response([synced.repeat(count)])),
    );
    let seen = 0;
    for await (const _ of createClient("http://fixture").session.log({
      sessionID: "ses_test",
    }))
      seen++;
    expect(seen).toBe(count);
  });

  it.each(["\n", "\r\n", "\r"])(
    "accepts split UTF-8 and %j frame boundaries",
    async (ending) => {
      const bytes = encoder.encode(
        `data: ${JSON.stringify({ text: "é" })}${ending}${ending}`,
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  for (const byte of bytes)
                    controller.enqueue(Uint8Array.of(byte));
                  controller.close();
                },
              }),
              {
                headers: { "content-type": "text/event-stream; charset=utf-8" },
              },
            ),
        ),
      );
      const values = [];
      for await (const event of createClient("http://fixture").session.log({
        sessionID: "ses_test",
      }))
        values.push(event);
      expect(values).toEqual([{ text: "é" }]);
    },
  );

  it("rejects an oversized UTF-8 frame before SDK decoding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(["data: ", "é".repeat(524_288)])),
    );
    const iterator = createClient("http://fixture")
      .session.log({ sessionID: "ses_test" })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("1 MiB");
  });

  it("still bounds SSE error responses and ordinary JSON responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(["x".repeat(1_048_577)], 401)),
    );
    const iterator = createClient("http://fixture")
      .session.log({ sessionID: "ses_test" })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow();
    await expect(
      createClient("http://fixture").server.info(),
    ).rejects.toThrow();
  });
});
