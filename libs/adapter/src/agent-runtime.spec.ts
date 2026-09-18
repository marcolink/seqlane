// @test-scope ./index.ts
import { describe, expect, it } from "vitest";
import { defineTask } from "@seqlane/core";
import { z } from "zod";
import { assertAgentRuntimeCapabilities, redactAgentAdapter } from "./index.js";

describe("agent runtime contract", () => {
  it("rejects an adapter whose declared capabilities do not match its operations", () => {
    const capabilities = {
      execute: true as const,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: false,
      checkpoint: true,
      fork: false,
      activity: false,
      sessionUi: false,
    };

    expect(() =>
      assertAgentRuntimeCapabilities(
        { capabilities, execute: async () => ({ ok: true }) },
        capabilities,
      ),
    ).toThrow(/capability/i);
  });

  it("redacts nested adapter errors and diagnostics", async () => {
    const task = defineTask({
      id: "fixture",
      input: z.unknown(),
      output: z.unknown(),
      execute: async () => undefined,
    });
    const failure = Object.assign(new Error("adapter failed at secret"), {
      code: "adapter-failure",
      cause: new Error("nested secret"),
    });
    const adapter = redactAgentAdapter(
      {
        capabilities: {
          execute: true,
          modelSelection: false,
          structuredOutput: true,
          sessionReuse: false,
          checkpoint: false,
          fork: false,
          activity: false,
          sessionUi: false,
        },
        execute: async (request) => {
          request.onDiagnostic?.({ code: "fixture", message: "secret" });
          throw failure;
        },
      },
      (value) => value.replaceAll("secret", "[REDACTED]"),
    );
    const diagnostics: string[] = [];

    await expect(
      adapter.execute({
        invocationId: "fixture:1",
        observability: {},
        task,
        input: null,
        signal: new AbortController().signal,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      }),
    ).rejects.toMatchObject({
      code: "adapter-failure",
      message: "adapter failed at [REDACTED]",
      cause: { message: "nested [REDACTED]" },
    });
    expect(diagnostics).toEqual(["[REDACTED]"]);
  });
});
