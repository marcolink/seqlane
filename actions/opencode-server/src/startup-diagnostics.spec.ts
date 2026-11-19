import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStartupDiagnostics } from "./startup-diagnostics.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("OpenCode startup diagnostics", () => {
  it("reports the bounded log tail and redacts supplied credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-diagnostics-"));
    directories.push(directory);
    const log = join(directory, "opencode.log");
    await writeFile(
      log,
      `old output\n${"x".repeat(20_000)}\nstartup failed token=private-token key=private-key\n`,
    );

    const message = await readStartupDiagnostics(log, [
      "private-token",
      "private-key",
      "",
    ]);
    expect(message).toContain("startup failed token=[REDACTED] key=[REDACTED]");
    expect(message).not.toContain("private-");
    expect(message).not.toContain("old output");
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(16 * 1024);
    await writeFile(log, "x".repeat(20_000));
    expect(await readStartupDiagnostics(log, [])).toBe(
      "OpenCode produced no startup log.",
    );
  });

  it("keeps an unavailable log from replacing the startup failure", async () => {
    expect(
      await readStartupDiagnostics("/does/not/exist/opencode.log", []),
    ).toBe("OpenCode startup log is unavailable.");
  });
});
