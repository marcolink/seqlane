import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import type { V2Client } from "./client.js";
import { createQuestionMonitor } from "./questions.js";
import { parseOutput } from "./prompt.js";
import { invocationMessages } from "./messages.js";
import { ownedSessions, runningWork } from "./owned-work.js";
import { createObserver } from "./observations.js";
import { monitorWithLiveEvents } from "./live-events.js";
import { OpenCodeV2Error } from "./errors.js";
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
  let owned = new Set([id]);
  try {
    return await monitorWithLiveEvents(
      client,
      (id) => owned.has(id),
      request.signal,
      async (signal) => {
        signal.throwIfAborted();
        const ids = await ownedSessions(client, id, workspace, signal);
        owned = ids;
        await checkQuestions(ids, signal);
        const messages = await invocationMessages(client, id, inputID, signal);
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
          const work = await runningWork(client, ids, workspace, signal);
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
            return { value: parseOutput(text, request) };
          }
        }
        return undefined;
      },
    );
  } finally {
    observer.finish();
  }
}
