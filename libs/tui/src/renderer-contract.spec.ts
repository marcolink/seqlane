import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createExecutionRenderer,
  type OutputCapabilities,
} from "./renderer-contract.js";
import * as packageExports from "./index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function source(relativePath: string): string {
  return readFileSync(`${root}/${relativePath}`, "utf8");
}

function capabilities(): OutputCapabilities {
  const sink = { write: () => undefined };
  return {
    isTTY: false,
    hasTerminalInput: false,
    supportsAnsi: false,
    supportsUnicode: false,
    width: 80,
    stdout: sink,
    stderr: sink,
  };
}

describe("seqlane tui package", () => {
  it("exports a renderer contract without terminal side effects", async () => {
    const renderer = createExecutionRenderer("ci", capabilities());

    expect(renderer.mode).toBe("ci");
    await expect(renderer.finish()).resolves.toBeUndefined();
  });

  it("exports only the renderer factory at runtime", () => {
    expect(Object.keys(packageExports)).toEqual(["createExecutionRenderer"]);
    expect(source("libs/tui/src/index.ts")).not.toMatch(
      /human-renderer|ci-renderer|run-view-model|redaction/,
    );
  });

  it("ships the core and canonical event dependencies", () => {
    const manifest = JSON.parse(source("libs/tui/package.json")) as {
      readonly dependencies?: Record<string, string>;
      readonly files?: readonly string[];
      readonly exports?: Record<string, unknown>;
    };

    expect(manifest.dependencies).toEqual({
      "@seqlane/core": "workspace:*",
      "@seqlane/protocol": "workspace:*",
      ink: "7.1.1",
      react: "19.3.0",
    });
    expect(manifest.files).toEqual(["dist", "!dist/**/*.tsbuildinfo"]);
    expect(manifest.exports).toMatchObject({
      ".": expect.any(Object),
    });
  });

  it("does not import runtime or executor implementations", () => {
    expect(
      source("libs/tui/src/index.ts") +
        source("libs/tui/src/renderer-contract.ts"),
    ).not.toMatch(/Mastra|OpenCode|seqlane-runtime/i);
  });
});
