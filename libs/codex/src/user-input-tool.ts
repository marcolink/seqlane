import { userInputRequestSchema } from "@seqlane/agent-adapter";
import { z } from "zod";

/** Private Codex dynamic tool; the shared request schema owns validation. */
export const askUserDynamicTool = {
  type: "function" as const,
  name: "ask_user",
  description: "Ask the user a structured question and wait for the answer.",
  inputSchema: z.toJSONSchema(userInputRequestSchema),
};

export const askUserInstructions =
  "When required information is missing, first inspect available context and tools. If it remains unavailable, call ask_user. If a skill requires input, use ask_user instead of asking only in prose. Ask concrete questions and offer choices when useful. Do not invent answers or request secrets. An answer does not grant permission to execute an operation; follow the existing permission policy.";
