// @test-scope ./structured-output-strategy.ts
import { describe, expect, it } from "vitest";
import {
  createStructuredOutputState,
  normalizeStructuredOutputConfiguration,
  resolveStructuredOutputStrategy,
} from "./structured-output-strategy.js";

describe("structured output strategy", () => {
  it("defaults to auto with two repair attempts", () => {
    expect(normalizeStructuredOutputConfiguration(undefined)).toMatchObject({
      strategy: "auto",
      retryCount: 2,
    });
  });

  it.each([-1, 1.5])("rejects invalid retry count %s", (retryCount) => {
    expect(() =>
      normalizeStructuredOutputConfiguration({ retryCount }),
    ).toThrow();
  });

  it.each([
    ["1.14.19", "native", "known-good-version"],
    ["1.14.48", "prompt", "affected-version"],
    ["1.17.13", "prompt", "affected-version"],
    ["1.18.27", "prompt", "affected-version"],
    [undefined, "prompt", "unknown-version"],
    ["not-a-version", "prompt", "unknown-version"],
    ["1.14.19-beta.1", "prompt", "unknown-version"],
  ] as const)(
    "resolves %s as %s because of %s",
    (version, strategy, reason) => {
      expect(resolveStructuredOutputStrategy("auto", version, false)).toEqual({
        strategy,
        reason,
      });
    },
  );

  it("respects explicit overrides", () => {
    expect(resolveStructuredOutputStrategy("native", "1.18.27", false)).toEqual(
      { strategy: "native", reason: "explicit" },
    );
    expect(resolveStructuredOutputStrategy("prompt", "1.14.19", false)).toEqual(
      { strategy: "prompt", reason: "explicit" },
    );
  });

  it("downgrades later auto selections after native readback failure", async () => {
    const diagnostics: unknown[] = [];
    const state = createStructuredOutputState({
      configuration: {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
      resolveVersion: async () => "1.14.19",
    });

    await expect(state.resolve()).resolves.toMatchObject({
      strategy: "native",
    });
    state.markNativeReadbackIncompatible("1.14.19");
    await expect(state.resolve()).resolves.toMatchObject({
      strategy: "prompt",
      retryCount: 2,
    });
    expect(diagnostics).toEqual([
      {
        type: "strategy-selected",
        strategy: "native",
        reason: "known-good-version",
        version: "1.14.19",
      },
      {
        type: "native-readback-incompatible",
        strategy: "native",
        version: "1.14.19",
      },
      {
        type: "strategy-selected",
        strategy: "prompt",
        reason: "runtime-downgrade",
        version: "1.14.19",
      },
    ]);
  });

  it("resolves the runtime version once", async () => {
    let calls = 0;
    const state = createStructuredOutputState({
      resolveVersion: async () => {
        calls += 1;
        return "1.14.19";
      },
    });

    await state.resolve();
    await state.resolve();
    expect(calls).toBe(1);
  });
});
