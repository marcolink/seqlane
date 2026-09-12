import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createExecutionRenderer,
  createNoopRenderer,
  type OutputCapabilities,
} from "./renderer-contract.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function source(relativePath: string): string {
  return readFileSync(`${root}/${relativePath}`, "utf8");
}

function capabilities(): OutputCapabilities {
  const sink = { write: () => undefined };
  return {
    isTTY: false,
    supportsAnsi: false,
    supportsUnicode: false,
    width: 80,
    stdout: sink,
    stderr: sink,
  };
}

describe("seqlane output package", () => {
  it("exports a renderer contract without terminal side effects", async () => {
    const renderer = createExecutionRenderer("ci", capabilities());

    expect(renderer.mode).toBe("ci");
    await expect(renderer.finish()).resolves.toBeUndefined();
  });

  it("provides a no-op renderer for package bootstrap", async () => {
    const renderer = createNoopRenderer("human");

    expect(renderer.mode).toBe("human");
    renderer.handle({
      type: "run.started",
      metadata: {
        schemaVersion: 1,
        eventId: "event-1",
        sequence: 1,
        occurredAt: "2026-08-18T00:00:00.000Z",
      },
      workId: "work-1",
      runId: "run-1",
    });
    await expect(renderer.finish()).resolves.toBeUndefined();
  });

  it("ships the core and canonical event dependencies", () => {
    const manifest = JSON.parse(source("libs/output/package.json")) as {
      readonly dependencies?: Record<string, string>;
      readonly files?: readonly string[];
      readonly exports?: Record<string, unknown>;
    };

    expect(manifest.dependencies).toEqual({
      "@seqlane/core": "workspace:*",
    });
    expect(manifest.files).toEqual(["dist"]);
    expect(manifest.exports).toMatchObject({
      ".": expect.any(Object),
    });
  });

  it("does not import runtime or executor implementations", () => {
    expect(
      source("libs/output/src/index.ts") +
        source("libs/output/src/renderer-contract.ts"),
    ).not.toMatch(/Mastra|OpenCode|seqlane-runtime/i);
  });
});
