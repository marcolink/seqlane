// @test-scope ./model-ref.ts
// @test-scope ./custom.ts
// @test-scope ./providers/openai.ts
// @test-scope ./providers/anthropic.ts

import { describe, expect, it } from "vitest";
import {
  anthropic,
  model,
  modelRefSchema,
  modelSelectionSchema,
  openai,
  reasoningEffortSchema,
  type ModelRef,
  type ModelSelection,
} from "./index.js";

describe("model selection", () => {
  it("creates immutable OpenAI and Anthropic model refs", () => {
    const openAIModel: ModelRef<"openai", "gpt-5.6-luna"> =
      openai("gpt-5.6-luna");
    const anthropicModel: ModelRef<"anthropic", "claude-sonnet-4-6"> =
      anthropic("claude-sonnet-4-6");

    expect(openAIModel).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(anthropicModel).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(Object.isFrozen(openAIModel)).toBe(true);
    expect(Object.isFrozen(anthropicModel)).toBe(true);
  });

  it("rejects unknown IDs in provider-specific helpers at compile time", () => {
    // Keep compile-time-only calls out of the runtime test path.
    const compileTimeOnly = false;
    if (compileTimeOnly) {
      // @ts-expect-error The provider helper only accepts generated OpenAI IDs.
      openai("gpt-5.6-lunna");
      // @ts-expect-error The provider helper only accepts generated Anthropic IDs.
      anthropic("claude-sonnet-4-6x");
    }
  });

  it("rejects unknown IDs in provider-specific helpers at runtime", () => {
    expect(() => openai("gpt-not-in-catalog" as never)).toThrow();
    expect(() => anthropic("claude-not-in-catalog" as never)).toThrow();
  });

  it("supports generic model references with slashes in the model ID", () => {
    const custom = model("acme/my/custom-model");

    expect(custom).toEqual({ provider: "acme", model: "my/custom-model" });
    expect(Object.isFrozen(custom)).toBe(true);
  });

  it.each(["", "openai", "/gpt-5.6-luna", "openai/"])(
    "rejects malformed generic reference %j",
    (reference) => {
      expect(() => model(reference)).toThrow();
    },
  );

  it("accepts the optional reasoning effort in a model selection", () => {
    const selection: ModelSelection = {
      model: openai("gpt-5.6-luna"),
      reasoning: "high",
    };

    expect(modelSelectionSchema.parse(selection)).toEqual(selection);
    expect(reasoningEffortSchema.safeParse("ultra").success).toBe(false);
  });

  it("rejects unknown fields and freezes parsed model contracts", () => {
    expect(
      modelRefSchema.safeParse({
        provider: "acme",
        model: "my-model",
        extra: true,
      }).success,
    ).toBe(false);

    const parsed = modelSelectionSchema.parse({
      model: { provider: "acme", model: "my-model" },
      reasoning: "low",
    });

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.model)).toBe(true);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });
});
