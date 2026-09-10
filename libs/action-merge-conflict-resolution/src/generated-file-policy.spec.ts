// @test-scope ./generated-file-policy.ts
// @test-scope ./contracts.ts

import { describe, expect, it } from "vitest";

import {
  matchesGeneratedFileGlob,
  parseConflictHandlers,
} from "./generated-file-policy.js";

describe("generated-file policy", () => {
  it("matches repository-relative exact, star, and double-star globs", () => {
    expect(matchesGeneratedFileGlob("pnpm-lock.yaml", "pnpm-lock.yaml")).toBe(
      true,
    );
    expect(
      matchesGeneratedFileGlob(
        "actions/*/dist/*.js",
        "actions/example/dist/main.js",
      ),
    ).toBe(true);
    expect(
      matchesGeneratedFileGlob("**/dist/*.js", "actions/example/dist/main.js"),
    ).toBe(true);
    expect(matchesGeneratedFileGlob("actions/*/dist/*.js", "src/main.js")).toBe(
      false,
    );
  });

  it("parses nested handler commands and setup recipes", () => {
    expect(
      parseConflictHandlers(
        JSON.stringify({
          version: 1,
          rules: [
            {
              match: "actions/*/dist/*.js",
              outputs: ["actions/*/dist/*.js"],
              handler: {
                setup: [["pnpm", "install", "--ignore-scripts"]],
                command: ["pnpm", "build"],
              },
            },
          ],
        }),
      ),
    ).toMatchObject({
      version: 1,
      rules: [{ handler: { command: ["pnpm", "build"] } }],
    });
  });

  it("rejects command strings, traversal, and malformed JSON", () => {
    expect(() => parseConflictHandlers("not-json")).toThrowError(
      expect.objectContaining({ code: "CONFLICT_HANDLERS_INVALID" }),
    );
    expect(() =>
      parseConflictHandlers({
        version: 1,
        rules: [
          {
            match: "../dist/*.js",
            outputs: ["dist/*.js"],
            handler: { command: ["pnpm build"] },
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONFLICT_HANDLERS_INVALID" }),
    );
  });

  it("rejects handlers that can override the built-in lockfile or overlap", () => {
    expect(() =>
      parseConflictHandlers({
        version: 1,
        rules: [
          {
            match: "**/*.yaml",
            outputs: ["**/*.yaml"],
            handler: { command: ["corepack", "pnpm", "build"] },
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONFLICT_HANDLERS_INVALID" }),
    );
    expect(() =>
      parseConflictHandlers({
        version: 1,
        rules: [
          {
            match: "actions/*/dist/*.js",
            outputs: ["actions/*/dist/*.js"],
            handler: { command: ["corepack", "pnpm", "build"] },
          },
          {
            match: "actions/example/dist/*.js",
            outputs: ["actions/example/dist/*.js"],
            handler: { command: ["corepack", "pnpm", "build"] },
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONFLICT_HANDLERS_INVALID" }),
    );
  });
});
