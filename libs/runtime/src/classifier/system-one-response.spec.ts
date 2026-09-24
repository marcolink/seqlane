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

const mixedRequest: ClassifierRequest = {
  state: { diff: "example diff" },
  questions: {
    area: {
      kind: "choice",
      instructions: "Which area changed?",
      criteria: { runtime: "Runtime", docs: "Documentation" },
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

  it("maps mixed Choice, Score, and Noul answers against their static questions", () => {
    const raw = {
      model: "jev-1.13.0",
      answers: {
        area: {
          type: "choice",
          choice: "runtime",
          probabilities: { runtime: 0.8, docs: 0.2 },
          confidence: 0.8,
          note: "choice detail",
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
      usage: { input_tokens: 10, output_tokens: 4 },
    };

    expect(mapSystemOneResponse(raw, mixedRequest).result).toEqual({
      model: "jev-1.13.0",
      answers: {
        area: {
          kind: "choice",
          selected: "runtime",
          probabilities: { runtime: 0.8, docs: 0.2 },
          confidence: 0.8,
          extensions: { note: "choice detail" },
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
      usage: { inputTokens: 10, outputTokens: 4 },
    });
  });

  it("rejects answers whose values disagree with the declared questions", () => {
    const valid = {
      model: "jev-1.13.0",
      answers: {
        area: {
          type: "choice",
          choice: "runtime",
          probabilities: { runtime: 0.8, docs: 0.2 },
          confidence: 0.8,
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
      usage: { input_tokens: 10, output_tokens: 4 },
    };

    expect(() =>
      mapSystemOneResponse(
        {
          ...valid,
          answers: {
            ...valid.answers,
            area: { ...valid.answers.area, choice: "security" },
          },
        },
        mixedRequest,
      ),
    ).toThrow();
    expect(() =>
      mapSystemOneResponse(
        {
          ...valid,
          answers: {
            ...valid.answers,
            priority: {
              ...valid.answers.priority,
              legend: { "0": "Low", "1": "Critical" },
            },
          },
        },
        mixedRequest,
      ),
    ).toThrow();
  });
});
