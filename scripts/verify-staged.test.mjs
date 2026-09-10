import assert from "node:assert/strict";
import test from "node:test";

import {
  eslintPaths,
  eslintArgs,
  isPrettierPath,
  overlappingPaths,
  prettierArgs,
  stagedPathsFromGitOutput,
} from "./verify-staged.mjs";

test("parses NUL-delimited staged paths without losing spaces", () => {
  assert.deepEqual(stagedPathsFromGitOutput("src/one.ts\0docs/My Guide.md\0"), [
    "src/one.ts",
    "docs/My Guide.md",
  ]);
});

test("selects supported formatting paths", () => {
  assert.equal(isPrettierPath(".github/workflows/ci.yml"), true);
  assert.equal(isPrettierPath("scripts/check.mjs"), true);
  assert.equal(isPrettierPath("actions/setup-opencode/action.yml"), true);
  assert.equal(isPrettierPath("image.png"), false);
});

test("selects only JavaScript and TypeScript paths for ESLint", () => {
  assert.deepEqual(
    eslintPaths([
      "src/main.ts",
      "scripts/check.mjs",
      "README.md",
      "config.json",
    ]),
    ["src/main.ts", "scripts/check.mjs"],
  );
});

test("detects files with both staged and unstaged changes", () => {
  assert.deepEqual(
    overlappingPaths(["src/one.ts", "docs/README.md"], ["docs/README.md"]),
    ["docs/README.md"],
  );
});

test("terminates formatter arguments before staged paths", () => {
  assert.deepEqual(prettierArgs(["-config.js"]), [
    "exec",
    "prettier",
    "--check",
    "--",
    "-config.js",
  ]);
  assert.deepEqual(eslintArgs(["-config.js"]), [
    "exec",
    "eslint",
    "--",
    "-config.js",
  ]);
});
