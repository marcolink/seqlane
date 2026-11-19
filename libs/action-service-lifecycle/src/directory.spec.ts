import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { assertDirectory } from "./directory.js";

it("accepts a directory, rejects files, and retains the native missing-path cause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seqlane-directory-"));
  try {
    await expect(
      Effect.runPromise(assertDirectory(directory)),
    ).resolves.toBeUndefined();
    const file = join(directory, "file");
    await writeFile(file, "fixture");
    await expect(Effect.runPromise(assertDirectory(file))).rejects.toThrow(
      `Configured working directory is not a directory: ${file}`,
    );
    await expect(
      Effect.runPromise(assertDirectory(join(directory, "missing"))),
    ).rejects.toMatchObject({
      reason: {
        _tag: "NotFound",
        cause: expect.objectContaining({ code: "ENOENT" }),
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
