import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";

/** Internal SDK client construction. The SDK client never crosses Seqlane's public boundary. */
export function createOpenCodeClient(url: string): OpencodeClient {
  return createOpencodeClient({ baseUrl: url });
}
