import type { SeqlaneSchema } from "@seqlane/core";
import {
  AcpStructuredOutputError,
  type AcpStructuredOutputIssue,
} from "./errors.js";

function issueMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.slice(0, 256);
}

function validationIssues(cause: unknown): readonly AcpStructuredOutputIssue[] {
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

export function parseStructuredOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new AcpStructuredOutputError(1, [
      {
        kind: "parse",
        code: "empty_output",
        message: "The response was empty",
      },
    ]);
  }

  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    const fenced = /^```json\s*\n([\s\S]*?)\n```$/.exec(trimmed);
    if (fenced?.[1] === undefined) {
      throw new AcpStructuredOutputError(
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
      return JSON.parse(fenced[1]);
    } catch (fencedCause) {
      throw new AcpStructuredOutputError(
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

export function validateStructuredOutput(
  value: unknown,
  schema: SeqlaneSchema,
): unknown {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new AcpStructuredOutputError(1, validationIssues(cause), cause);
  }
}

export function summarizeStructuredOutputIssues(
  issues: readonly AcpStructuredOutputIssue[],
): string {
  return issues
    .map(
      ({ kind, code, message, path }) =>
        `[${kind}] ${code}${path === undefined ? "" : ` at ${path}`}: ${message}`,
    )
    .join("; ")
    .slice(0, 1024);
}
