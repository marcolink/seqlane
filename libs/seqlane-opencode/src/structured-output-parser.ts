import type { SeqlaneSchema } from "@seqlane/core";
import {
  StructuredOutputValidationError,
  type StructuredOutputIssue,
} from "./errors.js";

function issueMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.slice(0, 256);
}

function zodIssues(cause: unknown): readonly StructuredOutputIssue[] {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("issues" in cause) ||
    !Array.isArray(cause.issues)
  ) {
    return [
      {
        kind: "validation",
        code: "schema_validation_failed",
        message: issueMessage(cause),
      },
    ];
  }

  return cause.issues.map((issue: unknown) => {
    if (typeof issue !== "object" || issue === null) {
      return {
        kind: "validation" as const,
        code: "schema_validation_failed",
        message: "Output did not satisfy the task schema",
      };
    }
    const record = issue as Record<string, unknown>;
    const path = Array.isArray(record.path)
      ? `/${record.path.map(String).join("/")}`
      : undefined;
    return {
      kind: "validation" as const,
      code: typeof record.code === "string" ? record.code : "invalid_output",
      message:
        typeof record.message === "string"
          ? record.message.slice(0, 256)
          : "Output did not satisfy the task schema",
      ...(path === undefined ? {} : { path }),
    };
  });
}

/** Parses only direct JSON or one complete ```json fenced block. */
export function parsePromptJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new StructuredOutputValidationError(1, [
      {
        kind: "parse",
        code: "empty_output",
        message: "The response was empty",
      },
    ]);
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (cause) {
    const fenced = /^```json\s*\n([\s\S]*?)\n```$/.exec(trimmed);
    if (fenced?.[1] === undefined) {
      throw new StructuredOutputValidationError(
        1,
        [
          {
            kind: "parse",
            code: "invalid_json",
            message: "The response was not valid JSON",
          },
        ],
        cause,
      );
    }
    try {
      return JSON.parse(fenced[1]) as unknown;
    } catch (fencedCause) {
      throw new StructuredOutputValidationError(
        1,
        [
          {
            kind: "parse",
            code: "invalid_json",
            message: "The fenced response was not valid JSON",
          },
        ],
        fencedCause,
      );
    }
  }
}

export function validatePromptJson(
  value: unknown,
  schema: SeqlaneSchema,
): unknown {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new StructuredOutputValidationError(1, zodIssues(cause), cause);
  }
}

export function summarizeStructuredOutputIssues(
  issues: readonly StructuredOutputIssue[],
): string {
  return issues
    .map(
      ({ kind, code, message, path }) =>
        `[${kind}] ${code}${path === undefined ? "" : ` at ${path}`}: ${message}`,
    )
    .join("; ")
    .slice(0, 1024);
}
