import type { OutputCapabilities } from "@seqlane/output";
import { describe, expect, it } from "vitest";
import {
  createCliRenderer,
  createOutputCapabilities,
  resolveRendererMode,
} from "./output.js";
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

  it("honors explicit CI mode", () => {
    expect(createCliRenderer("ci", capabilities).mode).toBe("ci");
  });

  it("configures known secret values for output redaction", () => {
    const stream = {
      isTTY: false,
      columns: 80,
      write: () => undefined,
    } as unknown as NodeJS.WriteStream;
    const output = createOutputCapabilities({
      stdout: stream,
      stderr: stream,
      env: {
        OPENAI_API_KEY: "openai-secret",
        GITHUB_TOKEN: "github-secret",
        SEQLANE_REDACT_VALUES: "custom-secret\nopenai-secret",
      },
    });

    expect(output.redactions).toEqual([
      "openai-secret",
      "github-secret",
      "custom-secret",
    ]);
  });

  it("parses supported modes and preserves the CLI error for invalid values", () => {
    expect(["auto", "human", "ci"].map(parseOutputMode)).toEqual([
      "auto",
      "human",
      "ci",
    ]);
    expect(() => parseOutputMode("invalid")).toThrow(
      "--output must be auto, human, or ci",
    );
  });
});
