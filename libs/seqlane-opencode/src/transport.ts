import type {
  Event as OpenCodeEvent,
  OpencodeClient,
} from "@opencode-ai/sdk/v2";
import { z } from "zod";
import { createOpenCodeClient } from "./client.js";
import type { OpenCodePrompt } from "./protocol.js";
const sessionSchema = z.looseObject({
  id: z.string().min(1),
  directory: z.string().min(1),
});

export interface OpenCodeSession {
  readonly sessionId: string;
  readonly directory: string;
  readonly workspace?: string;
}

export interface OpenCodeTransport {
  createSession(
    workspace: string | undefined,
    signal?: AbortSignal,
  ): Promise<OpenCodeSession>;
  forkSession(
    sessionId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeSession>;
  prompt(
    sessionId: string,
    request: OpenCodePrompt,
    signal?: AbortSignal,
  ): Promise<unknown>;
  subscribeEvents(signal: AbortSignal): Promise<AsyncIterable<OpenCodeEvent>>;
  abort(sessionId: string): Promise<void>;
}

/** Adapts the SDK's session API to the private session lifecycle. */
export function createOpenCodeTransport(url: string): OpenCodeTransport {
  return createOpenCodeTransportFromClient(createOpenCodeClient(url));
}

function createOpenCodeTransportFromClient(
  client: OpencodeClient,
): OpenCodeTransport {
  return {
    async createSession(workspace, signal) {
      const response = await client.session.create(
        {
          ...(workspace === undefined ? {} : { directory: workspace }),
        },
        { throwOnError: true, signal },
      );
      const session = sessionSchema.parse(response.data);
      return {
        sessionId: session.id,
        directory: session.directory,
        ...(workspace === undefined ? {} : { workspace: session.directory }),
      };
    },

    async prompt(sessionId, request, signal) {
      const response = await client.session.prompt(
        {
          sessionID: sessionId,
          parts: [{ type: "text", text: request.text }],
          format: {
            type: "json_schema",
            schema: request.schema,
          },
        },
        { throwOnError: true, signal },
      );
      return response.data;
    },

    async forkSession(sessionId, messageId, signal) {
      const response = await client.session.fork(
        { sessionID: sessionId, messageID: messageId },
        { throwOnError: true, signal },
      );
      const session = sessionSchema.parse(response.data);
      return { sessionId: session.id, directory: session.directory };
    },

    async subscribeEvents(signal) {
      const subscription = await client.event.subscribe({}, { signal });
      return subscription.stream;
    },
    async abort(sessionId) {
      await client.session.abort(
        { sessionID: sessionId },
        { throwOnError: true },
      );
    },
  };
}
