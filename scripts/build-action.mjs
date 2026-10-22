import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Replace the complete runner asset set only after every entrypoint builds. */
export async function buildAction(directory, main = "src/main.ts") {
  const stage = await mkdtemp(join(directory, ".action-build-"));
  const output = join(directory, "dist");
  const next = join(stage, "next");
  const previous = join(stage, "previous");
  let savedPrevious = false;
  try {
    const entryPoints = { main: resolve(directory, main) };
    for (const name of ["post", "process-anchor"]) {
      const source = join(directory, "src", `${name}.ts`);
      if (existsSync(source)) entryPoints[name] = source;
    }
    await build({
      absWorkingDir: directory,
      entryPoints,
      outdir: next,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      tsconfig: join(directory, "tsconfig.json"),
      minify: true,
      banner: {
        js: 'import { createRequire } from "node:module"; globalThis.require ??= createRequire(import.meta.url);',
      },
    });
    if (existsSync(output)) {
      await rename(output, previous);
      savedPrevious = true;
    }
    try {
      await rename(next, output);
    } catch (cause) {
      if (savedPrevious) await rename(previous, output);
      throw cause;
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await buildAction(process.cwd(), process.argv[2]);
}
