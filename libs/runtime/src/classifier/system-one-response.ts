import type {
  ClassifierRequest,
  ClassifierResult,
  JsonValue,
} from "@seqlane/core";
import {
  classifierResultSchema,
  jsonValueSchema,
  plainRecordSchema,
} from "@seqlane/core";
import { z } from "zod";

const knownResponseSchema = z.looseObject({
  model: z.string().min(1),
  answers: plainRecordSchema.pipe(z.record(z.string(), z.unknown())),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

const providerNoulAnswerSchema = z.looseObject({
  type: z.literal("noul"),
  noul: z.number().finite().min(0).max(1),
});

const extensionRecordSchema = plainRecordSchema.pipe(
  z.record(z.string(), jsonValueSchema),
);

function extensionsFrom(
  value: Record<string, unknown>,
  knownFields: readonly string[],
): Record<string, JsonValue> | undefined {
  const known = new Set(knownFields);
  const extensions = Object.fromEntries(
    Object.entries(value).filter(([key]) => !known.has(key)),
  );
  if (Object.keys(extensions).length === 0) return undefined;
  return extensionRecordSchema.parse(extensions);
}

function providerResponseSchemaFor(request: ClassifierRequest) {
  return knownResponseSchema.superRefine((response, context) => {
    const requestedIds = Object.keys(request.questions).sort();
    const responseIds = Object.keys(response.answers).sort();
    if (
      requestedIds.length !== responseIds.length ||
      requestedIds.some((id, index) => id !== responseIds[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["answers"],
        message: "Classifier answer IDs must match the request",
      });
      return;
    }
    for (const id of requestedIds) {
      if (!providerNoulAnswerSchema.safeParse(response.answers[id]).success) {
        context.addIssue({
          code: "custom",
          path: ["answers", id],
          message: "System One Noul answer is malformed",
        });
      }
    }
  });
}

function mapAnswer(raw: unknown): ClassifierResult["answers"][string] {
  const answer = providerNoulAnswerSchema.parse(raw);
  const extensions = extensionsFrom(answer, ["type", "noul"]);
  return {
    kind: "noul",
    probability: answer.noul,
    ...(extensions === undefined ? {} : { extensions }),
  };
}

export function mapSystemOneResponse(
  raw: unknown,
  request: ClassifierRequest,
): {
  readonly result: ClassifierResult;
  readonly rawResponse: JsonValue;
  readonly rawUsage: JsonValue;
} {
  const providerResponse = providerResponseSchemaFor(request).parse(raw);
  const answers = Object.fromEntries(
    Object.keys(request.questions).map((id) => [
      id,
      mapAnswer(providerResponse.answers[id]),
    ]),
  );
  const usageExtensions = extensionsFrom(providerResponse.usage, [
    "input_tokens",
    "output_tokens",
  ]);
  const responseExtensions = extensionsFrom(providerResponse, [
    "model",
    "answers",
    "usage",
  ]);
  const result = classifierResultSchema.parse({
    model: providerResponse.model,
    answers,
    usage: {
      inputTokens: providerResponse.usage.input_tokens,
      outputTokens: providerResponse.usage.output_tokens,
      ...(usageExtensions === undefined ? {} : { extensions: usageExtensions }),
    },
    ...(responseExtensions === undefined
      ? {}
      : { extensions: responseExtensions }),
  });
  const rawResponse = jsonValueSchema.parse(raw);
  const rawModel = plainRecordSchema.parse(raw);
  const rawUsage = jsonValueSchema.parse(rawModel.usage);
  return { result, rawResponse, rawUsage };
}
