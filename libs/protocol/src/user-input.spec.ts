// @test-scope ./user-input.ts
import { describe, expect, it } from "vitest";
import {
  interactionPolicySchema,
  userInputAnswersForRequestSchema,
  userInputRequestSchema,
} from "./user-input.js";

describe("user input protocol schemas", () => {
  const request = {
    questions: [
      {
        id: "region",
        prompt: "Choose a region",
        options: [
          { value: "eu-west", label: "Europe" },
          { value: "us-east", label: "United States" },
        ],
        allowFreeText: false,
      },
    ],
  };

  it("accepts a bounded choice request and its exact answer", () => {
    const parsed = userInputRequestSchema.parse(request);
    expect(
      userInputAnswersForRequestSchema(parsed).parse({ region: "eu-west" }),
    ).toEqual({ region: "eu-west" });
  });

  it("rejects duplicate ids, reserved ids, incompatible questions, and extra answer keys", () => {
    expect(
      userInputRequestSchema.safeParse({
        questions: [request.questions[0], request.questions[0]],
      }).success,
    ).toBe(false);
    expect(
      userInputRequestSchema.safeParse({
        questions: [{ id: "constructor", prompt: "x", allowFreeText: true }],
      }).success,
    ).toBe(false);
    expect(
      userInputRequestSchema.safeParse({
        questions: [{ id: "region", prompt: "x", allowFreeText: false }],
      }).success,
    ).toBe(false);
    expect(
      userInputAnswersForRequestSchema(request).safeParse({
        region: "eu-west",
        extra: "answer",
      }).success,
    ).toBe(false);
    expect(
      userInputAnswersForRequestSchema(request).safeParse({
        region: "asia",
      }).success,
    ).toBe(false);
  });

  it("requires free text to be nonblank and bounds its timeout policy", () => {
    const freeText = userInputRequestSchema.parse({
      questions: [{ id: "name", prompt: "Name?", allowFreeText: true }],
    });
    expect(
      userInputAnswersForRequestSchema(freeText).safeParse({ name: "  " })
        .success,
    ).toBe(false);
    expect(
      interactionPolicySchema.safeParse({ mode: "user-input", timeoutMs: 999 })
        .success,
    ).toBe(false);
    expect(
      interactionPolicySchema.parse({ mode: "user-input", timeoutMs: 3_000 }),
    ).toEqual({ mode: "user-input", timeoutMs: 3_000 });
  });
});
