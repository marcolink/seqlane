import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import { jsonValueSchema } from "@seqlane/core";
import { z } from "zod";
import { OpenCodeV2Error } from "./errors.js";

export function createPrompt(request: AgentAdapterRequest): string {
  const goal = request.agent?.goal;
  if (goal === undefined || goal.trim().length === 0)
    throw new OpenCodeV2Error(
      "configuration",
      "agent task requires a nonempty goal",
    );
  let serializedInput: string;
  try {
    serializedInput = JSON.stringify(jsonValueSchema.parse(request.input));
  } catch (cause) {
    throw new OpenCodeV2Error(
      "configuration",
      "task input must be a JSON value",
      cause,
    );
  }
  if (Buffer.byteLength(serializedInput, "utf8") > 1_048_576)
    throw new OpenCodeV2Error(
      "limit",
      "task input exceeded 1 MiB of serialized JSON",
    );
  try {
    return [
      goal,
      ...(request.agent?.instructions ?? []),
      "Task input:",
      serializedInput,
      "Return exactly one JSON value matching the following JSON Schema. Do not use Markdown or commentary.",
      JSON.stringify(z.toJSONSchema(request.task.output)),
    ].join("\n");
  } catch (cause) {
    throw new OpenCodeV2Error(
      "configuration",
      "task output cannot produce JSON Schema",
      cause,
    );
  }
}

export function parseOutput(
  text: string,
  request: AgentAdapterRequest,
): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return request.task.output.parse(value);
  } catch (cause) {
    throw new OpenCodeV2Error(
      "output",
      "response must be exactly one schema-valid JSON value",
      cause,
    );
  }
}
