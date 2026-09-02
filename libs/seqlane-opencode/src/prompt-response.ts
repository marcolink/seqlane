import {
  InteractionRequiredError,
  type InteractionRequirement,
  type SeqlaneInvocationMetrics,
} from "@seqlane/core";
import { z } from "zod";
import type { OpenCodePromptResult } from "./protocol.js";
import { extractStructuredOutput } from "./structured-output.js";

const responseSchema = z.looseObject({
  info: z.looseObject({
    id: z.string().min(1),
    sessionID: z.string().min(1),
    error: z.looseObject({ name: z.string() }).optional(),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    modelID: z.string(),
    providerID: z.string(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({ read: z.number(), write: z.number() }),
    }),
  }),
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

export function parseOpenCodePromptResponse(
  response: unknown,
): ParsedOpenCodePromptResponse {
  const parsed = responseSchema.parse(response);
  const requirement = getInteractionRequirement(parsed);
  if (requirement !== undefined) {
    throw new InteractionRequiredError(requirement);
  }

  return {
    structured: extractStructuredOutput(parsed),
    metrics: getResponseMetrics(parsed.info),
    checkpoint: {
      sessionId: parsed.info.sessionID,
      messageId: parsed.info.id,
    },
  };
}
