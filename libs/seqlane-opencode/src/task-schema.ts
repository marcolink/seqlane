import { z } from "zod";
import type { TaskDefinition } from "@seqlane/core";
import type { JsonSchema } from "./task.js";

/** Converts the task's runtime output contract to OpenCode's request format. */
export function toOpenCodeJsonSchema(task: TaskDefinition): JsonSchema {
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
