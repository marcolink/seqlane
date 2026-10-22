// @test-scope ./system-one-client.ts
// @test-scope ./system-one-http-attempt.ts

import { describe, expect, it } from "vitest";
import type { SeqlaneObservation } from "@seqlane/protocol";
import { SystemOneClient } from "./system-one-client.js";
import { CLASSIFIER_MAX_BODY_BYTES } from "./payload-limits.js";
import {
  classifierRequest as request,
  classifierResponseBody as responseBody,
} from "./system-one-client-fixtures.js";

describe("bounded System One response decoding", () => {
  it("preserves provider extras with a BOM and a split UTF-8 character at the byte limit", async () => {
    const document = { ...responseBody, provider_note: "€" };
    const encoded = Buffer.from(`\ufeff${JSON.stringify(document)}`);
    const splitAt = encoded.indexOf(Buffer.from("€")) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.subarray(0, splitAt));
        controller.enqueue(encoded.subarray(splitAt));
        controller.enqueue(
          Buffer.alloc(CLASSIFIER_MAX_BODY_BYTES - encoded.byteLength, 0x20),
        );
        controller.close();
      },
    });
    const observations: SeqlaneObservation[] = [];
    const client = new SystemOneClient(
      { url: "https://localhost/v1/systemone", model: "jev-latest" },
      async () => new Response(body),
    );

    await expect(
      client.classify(request, new AbortController().signal, (observation) =>
        observations.push(observation),
      ),
    ).resolves.toMatchObject({
      answers: { needsReview: { probability: 0.63 } },
      extensions: { provider_note: "€" },
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.model.response).toEqual(document);
  });

  it.each([
    {
      name: "one byte beyond the raw limit",
      bytes: Buffer.from(" "),
      prefixBytes: CLASSIFIER_MAX_BODY_BYTES,
      message: "Classifier response is too large",
    },
    {
      name: "an incomplete UTF-8 character at EOF",
      bytes: Buffer.from([0xe2, 0x82]),
      prefixBytes: 0,
      message: "Classifier response is not valid UTF-8",
    },
  ])(
    "rejects $name without retrying or retaining response data",
    async ({ bytes, prefixBytes, message }) => {
      let requests = 0;
      const observations: SeqlaneObservation[] = [];
      const client = new SystemOneClient(
        { url: "https://localhost/v1/systemone", model: "jev-latest" },
        async () => {
          requests += 1;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (prefixBytes > 0)
                  controller.enqueue(Buffer.alloc(prefixBytes, 0x20));
                controller.enqueue(bytes);
                controller.close();
              },
            }),
          );
        },
      );

      await expect(
        client.classify(request, new AbortController().signal, (observation) =>
          observations.push(observation),
        ),
      ).rejects.toMatchObject({ code: "response", message });
      expect(requests).toBe(1);
      expect(observations).toHaveLength(1);
      expect(observations[0]?.state).toBe("failed");
      expect(observations[0]?.model).not.toHaveProperty("response");
    },
  );
});
