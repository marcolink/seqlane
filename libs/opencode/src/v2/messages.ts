import { OpenCodeV2Error } from "./errors.js";
import { requestOptions, type V2Client } from "./client.js";
import { messagePageSchema, type NativeMessage } from "./schemas.js";

/** Reads a bounded suffix through the exact admitted input, in native order. */
export async function invocationMessages(
  client: V2Client,
  sessionID: string,
  inputID: string,
  signal: AbortSignal,
): Promise<NativeMessage[]> {
  const messages: NativeMessage[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = messagePageSchema.parse(
      await client.message.list(
        {
          sessionID,
          limit: 100,
          ...(cursor === undefined ? { order: "desc" as const } : { cursor }),
        },
        requestOptions(signal),
      ),
    );
    for (const message of result.data) {
      if (message.id === inputID) return messages.reverse();
      if (message.type === "user")
        throw new OpenCodeV2Error(
          "protocol",
          "another input changed the owned session",
        );
      messages.push(message);
    }
    const next = result.cursor.next;
    if (next == null) return [];
    if (cursors.has(next))
      throw new OpenCodeV2Error("protocol", "message cursor did not advance");
    cursors.add(next);
    cursor = next;
  }
  throw new OpenCodeV2Error(
    "limit",
    "invocation history exceeded 1000 messages",
  );
}
