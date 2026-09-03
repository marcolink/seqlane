// @test-scope ./mastra-runtime.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { mastraRuntimeSpineWorkflow } from "../../../fixtures/mastra-runtime-spine-workflow.js";
import { createMastraRuntime } from "./mastra-runtime.js";

const publicEntryPoint = fileURLToPath(
  new URL("../../index.ts", import.meta.url),
);

describe("private Mastra runtime spine", () => {
  it("executes a registered workflow and preserves run identity", async () => {
    const runtime = createMastraRuntime([
      { key: "fixture", workflow: mastraRuntimeSpineWorkflow },
    ]);

    await expect(
      runtime.run({
        workflowKey: "fixture",
        input: { fail: false },
        workId: "work-success",
        runId: "run-success",
      }),
    ).resolves.toEqual({
      status: "succeeded",
      result: {
        value: "Mastra runtime spine fixture succeeded",
        runId: "run-success",
        workId: "work-success",
      },
    });
  });

  it("normalizes a Mastra workflow failure without exposing Mastra details", async () => {
    const runtime = createMastraRuntime([
      { key: "fixture", workflow: mastraRuntimeSpineWorkflow },
    ]);

    const outcome = await runtime.run({
      workflowKey: "fixture",
      input: { fail: true },
      workId: "work-failure",
      runId: "run-failure",
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;

    expect(outcome.error).toMatchObject({
      category: "RuntimeError",
      message: "Seqlane runtime failed: Mastra runtime spine fixture failure",
    });
    expect(outcome.error.cause).toBeInstanceOf(Error);
    if (!(outcome.error.cause instanceof Error)) return;

    expect(outcome.error.cause).toMatchObject({
      message: "Mastra runtime spine fixture failure",
    });
    expect(outcome.error.cause.cause).toMatchObject({
      message: "Mastra runtime spine fixture failure",
      name: "Error",
    });
  });

  it("keeps Mastra imports out of the package public entry point", () => {
    expect(readFileSync(publicEntryPoint, "utf8")).not.toContain("@mastra/");
  });

  it("normalizes cancellation from an active Mastra run", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const step = createStep({
      id: "cancellable",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async ({ abortSignal }) => {
        started();
        await new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(new Error("step aborted")),
            { once: true },
          );
        });
        return null;
      },
    });
    const workflow = createWorkflow({
      id: "cancellable-workflow",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    })
      .then(step)
      .commit();
    const runtime = createMastraRuntime([{ key: workflow.id, workflow }]);
    const active = runtime.start({
      workflowKey: workflow.id,
      input: null,
      workId: "work-cancel",
      runId: "run-cancel",
    });

    await startedPromise;
    await active.cancel();
    await expect(active.outcome).resolves.toEqual({ status: "cancelled" });
  });
});
