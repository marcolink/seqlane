// @test-scope ./event-body.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import { boundedEventBody } from "./event-body.js";

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
    for await (const event of createClient("http://fixture").session.log({
      sessionID: "ses_test",
    })) {
      expect(event).toHaveProperty("type", "log.synced");
      seen++;
    }
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

  it.each([false, true])(
    "counts the complete CRLF boundary, split=%s",
    async (split) => {
      for (const excess of [0, 1]) {
        const text = "x".repeat(1_048_576 - 4 + excess) + "\r\n\r\n";
        const chunks = split ? [text.slice(0, -1), "\n"] : [text];
        const body = response(chunks).body!;
        const result = new Response(boundedEventBody(body, 1_048_576)).text();
        if (excess === 0) await expect(result).resolves.toBe(text);
        else await expect(result).rejects.toThrow("event frame exceeded 1 MiB");
      }
    },
  );

  it("never yields an oversized event with its final CRLF split across chunks", async () => {
    const prefix = 'data: {"text":"';
    const suffix = '"}\r\n\r\n';
    const text =
      prefix + "x".repeat(1_048_577 - prefix.length - suffix.length) + suffix;
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                source = controller;
                controller.enqueue(encoder.encode(text.slice(0, -1)));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const iterator = createClient("http://fixture")
      .session.log({ sessionID: "ses_test" })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    const early = await Promise.race([
      pending.then(
        () => "yielded",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    source?.enqueue(encoder.encode("\n"));
    source?.close();
    expect(early).toBe("pending");
    await expect(pending).rejects.toThrow("event frame exceeded 1 MiB");
  });

  it("holds a blank CR line until the following byte is counted", async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const text = "data: {}\r\n\r";
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(encoder.encode(text));
      },
    });
    const reader = boundedEventBody(body, text.length).getReader();
    const first = await reader.read();
    source?.enqueue(encoder.encode("\n"));
    source?.close();
    expect(new TextDecoder().decode(first.value)).toBe("data: {}\r\n");
    await expect(reader.read()).rejects.toThrow("event frame exceeded 1 MiB");
  });

  it("still bounds SSE error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(["x".repeat(1_048_577)], 401)),
    );
    const iterator = createClient("http://fixture")
      .session.log({ sessionID: "ses_test" })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("response exceeded 1 MiB");
  });

  it("bounds successful ordinary JSON responses before decoding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ value: "x".repeat(1_048_576) }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(createClient("http://fixture").server.info()).rejects.toThrow(
      "response exceeded 1 MiB",
    );
  });
});
