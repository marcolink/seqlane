import type { ClassifierRequest } from "@seqlane/core";

export const classifierRequest: ClassifierRequest = {
  state: "example diff",
  questions: {
    needsReview: {
      kind: "noul",
      instructions: "Does this diff need review?",
    },
  },
};

export const classifierResponseBody = {
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
