import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAction } from "./build-action.mjs";

test("a failed resident build preserves the entire previous runner asset set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seqlane-action-build-"));
  try {
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "dist"));
    await writeFile(join(directory, "tsconfig.json"), "{}");
    for (const name of ["main", "post", "process-anchor"]) {
      await writeFile(
        join(directory, "dist", `${name}.js`),
        `previous ${name}`,
      );
      await writeFile(
        join(directory, "src", `${name}.ts`),
        `export const value = "${name}";`,
      );
    }
    await writeFile(
      join(directory, "src/process-anchor.ts"),
      "export const = ;",
    );
    await assert.rejects(buildAction(directory));
    for (const name of ["main", "post", "process-anchor"]) {
      assert.equal(
        await readFile(join(directory, "dist", `${name}.js`), "utf8"),
        `previous ${name}`,
      );
    }
    await writeFile(
      join(directory, "src/process-anchor.ts"),
      "export const value = 'resident';",
    );
    await buildAction(directory);
    assert.deepEqual((await readdir(join(directory, "dist"))).sort(), [
      "main.js",
      "post.js",
      "process-anchor.js",
    ]);
    for (const name of ["main", "post", "process-anchor"]) {
      assert.match(
        await readFile(join(directory, "dist", `${name}.js`), "utf8"),
        /createRequire/,
      );
    }
    assert.deepEqual((await readdir(directory)).sort(), [
      "dist",
      "src",
      "tsconfig.json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
