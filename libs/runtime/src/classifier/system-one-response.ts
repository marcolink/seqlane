import type {
  ClassifierQuestion,
  ClassifierRequest,
  ClassifierResult,
  JsonValue,
} from "@seqlane/core";
import {
  createClassifierResultSchema,
  jsonValueSchema,
  plainRecordSchema,
} from "@seqlane/core";
import { z } from "zod";
import { parseBoundedJsonDocument } from "./payload-limits.js";
import { ClassifierFailure } from "./types.js";

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

const probabilitySchema = z.number().finite().min(0).max(1);

const providerChoiceAnswerSchema = z.looseObject({
  type: z.literal("choice"),
  choice: z.string().min(1),
  probabilities: plainRecordSchema.pipe(
    z.record(z.string(), probabilitySchema),
  ),
  confidence: probabilitySchema,
});

const providerScoreAnswerSchema = z.looseObject({
  type: z.literal("score"),
  score: z.number().finite(),
  legend: plainRecordSchema.pipe(z.record(z.string(), z.string())),
  probabilities: plainRecordSchema.pipe(
    z.record(z.string(), probabilitySchema),
  ),
  confidence: probabilitySchema,
});

const extensionRecordSchema = plainRecordSchema.pipe(
  z.record(z.string(), jsonValueSchema),
);

function extensionsFrom(
  value: Record<string, unknown>,
  knownFields: readonly string[],
  credential?: string,
): Record<string, JsonValue> | undefined {
  const known = new Set(knownFields);
  const extensions = Object.fromEntries(
    Object.entries(value).filter(([key]) => !known.has(key)),
  );
  if (Object.keys(extensions).length === 0) return undefined;
  const parsed = extensionRecordSchema.parse(extensions);
  if (
    credential !== undefined &&
    parseBoundedJsonDocument(
      parsed,
      "response extensions",
      "response",
      credential,
    ).hasExactString
  ) {
    throw new ClassifierFailure(
      "response",
      "Classifier response contains authentication data",
    );
  }
  return parsed;
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
      const question = request.questions[id];
      if (
        question === undefined ||
        !providerAnswerSchemaFor(question.kind).safeParse(response.answers[id])
          .success
      ) {
        context.addIssue({
          code: "custom",
          path: ["answers", id],
          message: "System One answer does not match its question kind",
        });
      }
    }
  });
}

function providerAnswerSchemaFor(kind: ClassifierQuestion["kind"]) {
  switch (kind) {
    case "choice":
      return providerChoiceAnswerSchema;
    case "score":
      return providerScoreAnswerSchema;
    case "noul":
      return providerNoulAnswerSchema;
  }
}

function mapAnswer(
  raw: unknown,
  question: ClassifierQuestion,
  credential?: string,
): ClassifierResult["answers"][string] {
  switch (question.kind) {
    case "choice": {
      const answer = providerChoiceAnswerSchema.parse(raw);
      const extensions = extensionsFrom(
        answer,
        ["type", "choice", "probabilities", "confidence"],
        credential,
      );
      return {
        kind: "choice",
        selected: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        ...(extensions === undefined ? {} : { extensions }),
      };
    }
    case "score": {
      const answer = providerScoreAnswerSchema.parse(raw);
      const extensions = extensionsFrom(
        answer,
        ["type", "score", "legend", "probabilities", "confidence"],
        credential,
      );
      return {
        kind: "score",
        value: answer.score,
        legend: answer.legend,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        ...(extensions === undefined ? {} : { extensions }),
      };
    }
    case "noul": {
      const answer = providerNoulAnswerSchema.parse(raw);
      const extensions = extensionsFrom(answer, ["type", "noul"], credential);
      return {
        kind: "noul",
        probability: answer.noul,
        ...(extensions === undefined ? {} : { extensions }),
      };
    }
  }
}

export function mapSystemOneResponse(
  raw: unknown,
  request: ClassifierRequest,
  credential?: string,
): {
  readonly result: ClassifierResult;
  readonly rawResponse: JsonValue;
  readonly rawUsage: JsonValue;
} {
  const providerResponse = providerResponseSchemaFor(request).parse(raw);
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => [
      id,
      mapAnswer(providerResponse.answers[id], question, credential),
    ]),
  );
  const usageExtensions = extensionsFrom(
    providerResponse.usage,
    ["input_tokens", "output_tokens"],
    credential,
  );
  const responseExtensions = extensionsFrom(
    providerResponse,
    ["model", "answers", "usage"],
    credential,
  );
  const result = createClassifierResultSchema(request.questions).parse({
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
