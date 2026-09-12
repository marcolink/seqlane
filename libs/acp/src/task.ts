import type { TaskDefinition } from "@seqlane/core";
import { z } from "zod";

export type JsonSchema = { readonly [key: string]: unknown };

export function toJsonSchema(task: TaskDefinition): JsonSchema {
  if (!(task.output instanceof z.ZodType)) {
    throw new Error(
      `Agent task "${task.id}" output schema cannot produce JSON Schema`,
    );
  }

  try {
    return z.toJSONSchema(task.output);
  } catch (cause) {
    throw new Error(
      `Agent task "${task.id}" output schema cannot produce JSON Schema`,
      { cause },
    );
  }
}
