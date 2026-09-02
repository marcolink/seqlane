import type { OutputCapabilities } from "@seqlane/output";
import { describe, expect, it } from "vitest";
import { createCliRenderer, resolveRendererMode } from "./output.js";
import { parseOutputMode } from "./output-mode.js";

const capabilities: OutputCapabilities = {
  isTTY: true,
  supportsAnsi: true,
  supportsUnicode: true,
  width: 80,
  stdout: { write: () => undefined },
  stderr: { write: () => undefined },
};

describe("CLI output mode selection", () => {
  it("selects human mode for an interactive local terminal", () => {
    expect(resolveRendererMode("auto", capabilities, { CI: undefined })).toBe(
      "human",
    );
  });

  it("selects CI mode for CI and non-TTY execution", () => {
    expect(resolveRendererMode("auto", capabilities, { CI: "true" })).toBe(
      "ci",
    );
    expect(
      resolveRendererMode(
        "auto",
        { isTTY: false, supportsAnsi: false },
        { CI: undefined },
      ),
    ).toBe("ci");
  });

  it("selects CI mode when ANSI redraw is unavailable", () => {
    expect(
      resolveRendererMode(
        "auto",
        { isTTY: true, supportsAnsi: false },
        { CI: undefined },
      ),
    ).toBe("ci");
  });

  it("honors explicit JSON and CI modes", () => {
    expect(createCliRenderer("json", capabilities).mode).toBe("json");
    expect(createCliRenderer("ci", capabilities).mode).toBe("ci");
  });

  it("parses supported modes and preserves the CLI error for invalid values", () => {
    expect(["auto", "human", "ci", "json"].map(parseOutputMode)).toEqual([
      "auto",
      "human",
      "ci",
      "json",
    ]);
    expect(() => parseOutputMode("invalid")).toThrow(
      "--output must be auto, human, ci, or json",
    );
  });
});
