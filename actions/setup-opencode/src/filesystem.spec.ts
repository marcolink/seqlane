// @test-scope ./filesystem.ts

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { locateExecutable, sha256File } from "./filesystem.js";

describe("OpenCode archive filesystem handling", () => {
  it("locates and makes the single executable runnable", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    try {
      await mkdir(join(root, "nested"));
      const executable = join(root, "nested", "opencode");
      await writeFile(executable, "binary");
      await chmod(executable, 0o600);
      expect(await locateExecutable(root)).toBe(executable);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing and duplicate executables", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    try {
      await expect(locateExecutable(root)).rejects.toThrow(/exactly one/);
      await mkdir(join(root, "nested"));
      await writeFile(join(root, "opencode"), "one");
      await writeFile(join(root, "nested", "opencode"), "two");
      await expect(locateExecutable(root)).rejects.toThrow(/exactly one/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an additional executable in the archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    try {
      const executable = join(root, "opencode");
      await writeFile(executable, "one");
      await writeFile(join(root, "unexpected"), "two");
      await chmod(join(root, "unexpected"), 0o755);
      await expect(locateExecutable(root)).rejects.toThrow(
        /unexpected executable/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hashes archive bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    try {
      const file = join(root, "archive");
      await writeFile(file, "OpenCode");
      await expect(sha256File(file)).resolves.toBe(
        "3af0e55ccc96d87ce0f167c9b1bdf63212d20aece6aa24eeac88ec438674dfb0",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
