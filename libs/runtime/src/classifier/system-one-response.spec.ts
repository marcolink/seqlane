// @test-scope ./system-one-response.ts

import { describe, expect, it } from "vitest";
import type { ClassifierRequest } from "@seqlane/core";
import { mapSystemOneResponse } from "./system-one-response.js";

const request: ClassifierRequest = {
  state: "example diff",
  questions: {
    needsReview: {
      kind: "noul",
      instructions: "Does this diff need review?",
    },
  },
};

describe("System One response mapping", () => {
  it("maps a Noul answer and preserves bounded extensions", () => {
    const raw = {
      model: "jev-1.13.0",
      answers: {
        needsReview: {
          type: "noul",
          noul: 0.63,
          note: "provider answer detail",
        },
      },
      usage: { input_tokens: 10, output_tokens: 2, cached_tokens: 4 },
      request_trace: { fixture: true },
    };

    expect(mapSystemOneResponse(raw, request)).toEqual({
      result: {
        model: "jev-1.13.0",
        answers: {
          needsReview: {
            kind: "noul",
            probability: 0.63,
            extensions: { note: "provider answer detail" },
          },
        },
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          extensions: { cached_tokens: 4 },
        },
        extensions: { request_trace: { fixture: true } },
      },
      rawResponse: raw,
      rawUsage: raw.usage,
    });
  });

  it("rejects answer IDs that do not match the request", () => {
    expect(() =>
      mapSystemOneResponse(
        {
          model: "jev-1.13.0",
          answers: { extra: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        request,
      ),
    ).toThrow();
  });
});
