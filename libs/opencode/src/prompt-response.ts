import {
  InteractionRequiredError,
  type InteractionRequirement,
  type SeqlaneInvocationMetrics,
} from "@seqlane/core";
import { z } from "zod";
import type { OpenCodePromptResult } from "./protocol.js";
import { OpenCodeProviderApiError } from "./errors.js";
import { extractStructuredOutput } from "./structured-output.js";
import { terminalObservationFromParsedResponse } from "./observations.js";

const nonNegativeFinite = z.number().finite().nonnegative();

const providerApiErrorSchema = z.object({
  name: z.literal("APIError"),
  data: z.object({
    statusCode: z.number().int().optional(),
    isRetryable: z.boolean(),
  }),
});

const responseSchema = z.looseObject({
  info: z.looseObject({
    id: z.string().min(1),
    sessionID: z.string().min(1),
    role: z.literal("assistant"),
    error: z.looseObject({ name: z.string() }).optional(),
    time: z.object({
      created: nonNegativeFinite,
      completed: nonNegativeFinite.optional(),
    }),
    modelID: z.string(),
    providerID: z.string(),
    cost: nonNegativeFinite,
    tokens: z.object({
      total: nonNegativeFinite.optional(),
      input: nonNegativeFinite,
      output: nonNegativeFinite,
      reasoning: nonNegativeFinite,
      cache: z.object({ read: nonNegativeFinite, write: nonNegativeFinite }),
    }),
  }),
  parts: z.array(
    z.looseObject({ type: z.string(), text: z.string().optional() }),
  ),
});

const interactionRequirements: Readonly<
  Record<string, InteractionRequirement>
> = {
  PermissionAsked: "user-input",
  PermissionRequired: "user-input",
  QuestionAsked: "user-input",
  QuestionRequired: "user-input",
  UserInputAsked: "user-input",
  UserInputRequired: "user-input",
  ConfirmationAsked: "confirmation",
  ConfirmationRequired: "confirmation",
  OptionSelectionAsked: "option-selection",
  OptionSelectionRequired: "option-selection",
  SelectionAsked: "option-selection",
  SelectionRequired: "option-selection",
  InteractionRequired: "user-input",
  TuiPromptRequired: "user-input",
};

function getInteractionRequirement(
  response: z.infer<typeof responseSchema>,
): InteractionRequirement | undefined {
  const name = response.info.error?.name;
  return name === undefined ? undefined : interactionRequirements[name];
}

function getProviderApiError(
  response: z.infer<typeof responseSchema>,
): OpenCodeProviderApiError | undefined {
  const parsed = providerApiErrorSchema.safeParse(response.info.error);
  if (!parsed.success) return undefined;

  // Provider messages and response bodies can contain request data. Retain only
  // the structured fields needed for a safe, actionable failure.
  return new OpenCodeProviderApiError(
    parsed.data.data.statusCode,
    parsed.data.data.isRetryable,
    parsed.data,
  );
}

function getResponseMetrics(
  info: z.infer<typeof responseSchema>["info"],
): SeqlaneInvocationMetrics {
  const completed = info.time.completed;
  return {
    ...(completed === undefined
      ? {}
      : { durationMs: Math.max(0, completed - info.time.created) }),
    model: info.modelID,
    provider: info.providerID,
    cost: info.cost,
    tokens: {
      ...(info.tokens.total === undefined ? {} : { total: info.tokens.total }),
      input: info.tokens.input,
      output: info.tokens.output,
      reasoning: info.tokens.reasoning,
      cacheRead: info.tokens.cache.read,
      cacheWrite: info.tokens.cache.write,
    },
  };
}

interface ParsedOpenCodePromptResponse extends OpenCodePromptResult {
  readonly checkpoint: {
    readonly sessionId: string;
    readonly messageId: string;
  };
}

function extractAssistantText(
  response: z.infer<typeof responseSchema>,
): string {
  const text = response.parts
    .filter((part) => part.type === "text" && part.text !== undefined)
    .map((part) => part.text)
    .join("\n");
  if (text.trim().length === 0) {
    throw new Error("OpenCode response did not contain assistant text");
  }
  return text;
}

export function parseOpenCodePromptResponse(
  response: unknown,
  strategy: "native" | "prompt" = "native",
): ParsedOpenCodePromptResponse {
  const parsed = responseSchema.parse(response);
  const requirement = getInteractionRequirement(parsed);
  if (requirement !== undefined) {
    throw new InteractionRequiredError(requirement);
  }
  const providerError = getProviderApiError(parsed);
  if (providerError !== undefined) throw providerError;

  return {
    structured:
      strategy === "native" ? extractStructuredOutput(parsed) : undefined,
    ...(strategy === "prompt" ? { text: extractAssistantText(parsed) } : {}),
    metrics: getResponseMetrics(parsed.info),
    observation: terminalObservationFromParsedResponse(parsed.info),
    checkpoint: {
      sessionId: parsed.info.sessionID,
      messageId: parsed.info.id,
    },
  };
}
