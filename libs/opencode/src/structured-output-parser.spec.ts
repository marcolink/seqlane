// @test-scope ./structured-output-parser.ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StructuredOutputValidationError } from "./errors.js";
import {
  parsePromptJson,
  validatePromptJson,
} from "./structured-output-parser.js";

describe("prompt structured output parser", () => {
  it("parses direct JSON", () => {
    expect(parsePromptJson('  {"answer":"ok"}  ')).toEqual({ answer: "ok" });
  });

  it("parses one json Markdown fence", () => {
    expect(parsePromptJson('```json\n{"answer":"ok"}\n```')).toEqual({
      answer: "ok",
    });
  });

  it.each([
    'Here is the result: {"answer":"ok"}',
    '```json\n{"answer":"ok"}\n```\n```json\n{"answer":"again"}\n```',
    "not JSON",
    "",
  ])("rejects ambiguous or invalid response %j", (response) => {
    expect(() => parsePromptJson(response)).toThrow(
      StructuredOutputValidationError,
    );
  });

  it("returns the canonical transformed schema value", () => {
    expect(
      validatePromptJson(
        { answer: " ok " },
        z.object({ answer: z.string().trim() }),
      ),
    ).toEqual({ answer: "ok" });
  });

  it("reports schema validation separately from parsing", () => {
    try {
      validatePromptJson({ answer: 1 }, z.object({ answer: z.string() }));
      throw new Error("expected validation failure");
    } catch (cause) {
      expect(cause).toMatchObject({
        name: "StructuredOutputValidationError",
        issues: [expect.objectContaining({ kind: "validation" })],
      });
    }
  });
});
