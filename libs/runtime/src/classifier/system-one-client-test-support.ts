import type { ClassifierRequest } from "@seqlane/core";
import { Context, Effect } from "effect";
import type { SystemOneClient } from "./system-one-client.js";
import type { ClassifierRequestInput } from "@seqlane/core";
import type { ClassifierObservationSink } from "./types.js";

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

/** Promise boundary for HTTP tests; policy tests compose the native Effect. */
export function classifyPromise(
  client: SystemOneClient,
  input: ClassifierRequestInput,
  signal: AbortSignal,
  onObservation: ClassifierObservationSink,
  context: Context.Context<never> = Context.empty(),
) {
  return Effect.runPromiseWith(context)(
    client.classify(input, signal, onObservation),
  );
}
