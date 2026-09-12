import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const action = await readFile(
  new URL("../action.yml", import.meta.url),
  "utf8",
);
assert.match(action, /using: node24/);
assert.match(action, /post-if: always\(\)/);
for (const input of [
  "github-token",
  "repository",
  "pull-request-number",
  "review-target",
  "base-branch",
  "base-revision",
  "head-revision",
  "runtime",
]) {
  assert.match(action, new RegExp(`^  ${input}:`, "m"));
}
for (const output of [
  "verdict",
  "reviewed-revision",
  "work-id",
  "run-id",
  "publication-status",
]) {
  assert.match(action, new RegExp(`^  ${output}:`, "m"));
}
const mainSource = await readFile(
  new URL("../src/main.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  mainSource,
  /apps\/cli|child_process|dynamicImport|pnpm install/,
);
const main = await readFile(
  new URL("../dist/main.js", import.meta.url),
  "utf8",
);
const post = await readFile(
  new URL("../dist/post.js", import.meta.url),
  "utf8",
);
assert.ok(main.length > 1000);
assert.ok(post.length > 1000);

for (const bundle of ["main.js", "post.js"]) {
  await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "await import(process.argv[1])",
      new URL(`../dist/${bundle}`, import.meta.url),
    ],
    { env: { ...process.env, NODE_ENV: "test" } },
  );
}
