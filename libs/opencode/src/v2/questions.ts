import { Effect } from "effect";
import { InteractionRequiredError } from "@seqlane/core";
import {
  userInputAnswerSchema,
  userInputAnswersForRequestSchema,
  userInputRequestSchema,
  type AgentAdapterRequest,
} from "@seqlane/agent-adapter";
import { openCodeEffect } from "../effect-boundary.js";
import { requestOptions, type V2Client } from "./client.js";
import { OpenCodeV2Error } from "./errors.js";
import {
  pendingSchema,
  questionFormDetailSchema,
  questionFormAnswerSchema,
  questionFormListSchema,
  questionFormSchema,
  type NativeQuestionForm,
} from "./schemas.js";

export function translateQuestionForm(
  form: NativeQuestionForm,
  redact: (text: string) => string,
) {
  const request = userInputRequestSchema.parse({
    questions: form.fields.map((field, index) => ({
      id: `question_${index}`,
      prompt: redact(
        [field.title, field.description].filter(Boolean).join("\n"),
      ),
      allowFreeText:
        field.custom === true ||
        field.options === undefined ||
        field.options.length === 0,
      ...(field.options?.length
        ? {
            options: field.options.map((option, index) => ({
              value: `option_${index}`,
              label: redact(
                [option.label, option.description].filter(Boolean).join(": "),
              ),
            })),
          }
        : {}),
    })),
  });
  return {
    request,
    answer(raw: unknown): Record<string, string> {
      const response = userInputAnswerSchema.parse(raw);
      const answers = userInputAnswersForRequestSchema(request).parse(
        response.answers,
      );
      return questionFormAnswerSchema.parse(
        Object.fromEntries(
          form.fields.map((field, index) => {
            const value = answers[`question_${index}`];
            const selected = request.questions[index]?.options?.findIndex(
              (option) => option.value === value,
            );
            const option =
              selected === undefined ? undefined : field.options?.[selected];
            return [field.key, option?.value ?? value];
          }),
        ),
      );
    },
  };
}

/** One monitor owns form replies; a failed invocation never retries a reply. */
function createQuestionHandler(
  client: V2Client,
  request: AgentAdapterRequest,
  redact: (text: string) => string,
) {
  const seen = new Map<string, string>();
  return async (
    sessionID: string,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<void> => {
    const identities = questionFormListSchema.parse(raw);
    for (const identity of identities) {
      if (
        identity.sessionID !== sessionID ||
        (seen.has(identity.id) && seen.get(identity.id) !== sessionID)
      )
        throw new OpenCodeV2Error(
          "protocol",
          "native question has a different owner",
        );
    }
    for (const rawForm of identities) {
      const parsed = questionFormSchema.safeParse(rawForm);
      if (!parsed.success)
        throw new OpenCodeV2Error(
          "protocol",
          "unsupported or malformed native question form",
          parsed.error,
        );
      const form = parsed.data;
      if (seen.has(form.id)) continue;
      seen.set(form.id, sessionID);
      await replyToQuestion(client, { ...request, signal }, redact, form);
    }
  };
}

async function replyToQuestion(
  client: V2Client,
  request: AgentAdapterRequest,
  redact: (text: string) => string,
  form: NativeQuestionForm,
): Promise<void> {
  const sessionID = form.sessionID;
  const input = { sessionID, formID: form.id };
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const detail = questionFormDetailSchema.parse(
          yield* openCodeEffect((signal) =>
            client.session.form.get(input, requestOptions(signal)),
          ),
        );
        if (detail.id !== form.id || detail.sessionID !== sessionID)
          return yield* Effect.fail(
            new OpenCodeV2Error(
              "protocol",
              "native question detail has a different identity or owner",
            ),
          );
        if (detail.state.status !== "pending") return;
        const translated = translateQuestionForm(detail, redact);
        const callback = request.requestUserInput;
        if (callback === undefined)
          return yield* Effect.fail(
            new OpenCodeV2Error(
              "configuration",
              "question callback is unavailable",
            ),
          );
        const rawAnswer = yield* openCodeEffect(() =>
          callback(translated.request),
        );
        const answer = translated.answer(rawAnswer);
        yield* openCodeEffect((signal) =>
          client.session.form.reply(
            { ...input, answer },
            requestOptions(signal),
          ),
        );
      }),
      { signal: request.signal },
    );
  } catch (cause) {
    try {
      // Cancellation has its own deadline so it finishes before session cleanup.
      await client.session.form.cancel(
        input,
        requestOptions(AbortSignal.timeout(5_000)),
      );
    } catch (cleanup) {
      throw new OpenCodeV2Error(
        "termination",
        "native question cancellation is unconfirmed",
        new AggregateError([cause, cleanup]),
      );
    }
    throw cause;
  }
}

export function createQuestionMonitor(
  client: V2Client,
  request: AgentAdapterRequest,
  redact: (text: string) => string,
) {
  const handleQuestions = createQuestionHandler(client, request, redact);
  return async (
    ids: ReadonlySet<string>,
    signal = request.signal,
  ): Promise<void> => {
    const sessionIDs = [...ids];
    for (let offset = 0; offset < sessionIDs.length; offset += 16) {
      const pending = await Promise.all(
        sessionIDs.slice(offset, offset + 16).map(async (sessionID) => {
          const [permissions, forms] = await Promise.all([
            client.permission.list({ sessionID }, requestOptions(signal)),
            client.session.form.list({ sessionID }, requestOptions(signal)),
          ]);
          return {
            sessionID,
            permissions: pendingSchema.parse(permissions),
            forms,
          };
        }),
      );
      if (pending.some(({ permissions }) => permissions.length > 0))
        throw new InteractionRequiredError("user-input");
      for (const { sessionID, forms } of pending) {
        if (request.requestUserInput === undefined) {
          if (pendingSchema.parse(forms).length > 0)
            throw new InteractionRequiredError("user-input");
        } else await handleQuestions(sessionID, forms, signal);
      }
    }
  };
}
