import { setTimeout } from "node:timers/promises";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import type { V2Client } from "./client.js";
import { parseOutput } from "./prompt.js";
import { invocationMessages } from "./messages.js";
import { ownedSessions, runningWork } from "./owned-work.js";
import { createObserver } from "./observations.js";
import { OpenCodeV2Error } from "./errors.js";
import { createQuestionMonitor } from "./questions.js";
import {
  assertAssistantModel,
  type PinnedNativeModel,
} from "./session-model.js";
export async function waitForResult(
  client: V2Client,
  workspace: string,
  redact: (text: string) => string,
  request: AgentAdapterRequest,
  id: string,
  inputID: string,
  expectedModel: PinnedNativeModel,
): Promise<unknown> {
  const observer = createObserver(request, redact);
  const checkQuestions = createQuestionMonitor(client, request, redact);
  try {
    while (true) {
      request.signal.throwIfAborted();
      const ids = await ownedSessions(client, id, workspace, request.signal);
      await checkQuestions(ids);
      const messages = await invocationMessages(
        client,
        id,
        inputID,
        request.signal,
      );
      for (const message of messages)
        if (message.type === "assistant")
          assertAssistantModel(message.model, expectedModel);
      observer.observe(messages);
      const idle =
        messages.at(-1)?.type === "idle" ? messages.at(-1) : undefined;
      if (idle !== undefined) {
        if (idle.type !== "idle" || idle.outcome !== "succeeded")
          throw new OpenCodeV2Error(
            "execution",
            "native invocation did not succeed",
          );
        const work = await runningWork(client, ids, workspace, request.signal);
        if (!work.active && work.shells.length === 0) {
          const assistant = messages
            .filter((message) => message.type === "assistant")
            .at(-1);
          if (
            assistant?.type !== "assistant" ||
            assistant.error !== undefined ||
            assistant.time.completed === undefined
          )
            throw new OpenCodeV2Error(
              "protocol",
              "completed input has no terminal assistant answer",
            );
          const text = assistant.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          return parseOutput(text, request);
        }
      }
      await setTimeout(1_000, undefined, { signal: request.signal });
    }
  } finally {
    observer.finish();
  }
}
