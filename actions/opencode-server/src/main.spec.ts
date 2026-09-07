import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import * as core from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processAnchorPath, run } from "./main.js";

vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
}));

const originalActionPath = process.env.GITHUB_ACTION_PATH;

afterEach(() => {
  vi.clearAllMocks();
  if (originalActionPath === undefined) {
    delete process.env.GITHUB_ACTION_PATH;
  } else {
    process.env.GITHUB_ACTION_PATH = originalActionPath;
  }
});

describe("OpenCode action input adapter", () => {
  it("requires an executable before starting the service", async () => {
    vi.mocked(core.getInput).mockImplementation((name, options) => {
      if (name === "executable") {
        expect(options).toEqual({ required: true });
        throw new Error("Input required");
      }

      if (name === "working-directory") {
        return "/tmp";
      }

      return "";
    });

    await expect(run()).rejects.toThrow("Input required");
    expect(core.getInput).toHaveBeenCalledWith("executable", {
      required: true,
    });
  });
});

describe("OpenCode action process anchor", () => {
  it("resolves the shipped anchor without GITHUB_ACTION_PATH", () => {
    delete process.env.GITHUB_ACTION_PATH;

    const anchorPath = processAnchorPath();

    expect(basename(anchorPath)).toBe("process-anchor.js");
    expect(anchorPath).toBe(
      fileURLToPath(new URL("../process-anchor.js", import.meta.url)),
    );
    expect(existsSync(anchorPath)).toBe(true);
  });
});
