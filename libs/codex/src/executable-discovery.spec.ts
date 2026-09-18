// @test-scope ./executable-discovery.ts
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_EXECUTABLE_CONFIGURED_PATH_UNAVAILABLE,
  CODEX_EXECUTABLE_NOT_FOUND,
  CodexExecutableDiscoveryError,
  resolveCodexExecutable,
  type CodexExecutableDiscoveryOptions,
} from "./executable-discovery.js";

function discoveryOptions(
  executablePaths: readonly string[],
  overrides: Partial<CodexExecutableDiscoveryOptions> = {},
): CodexExecutableDiscoveryOptions {
  const usable = new Set(executablePaths);
  return {
    environment: { PATH: "/first:/second" },
    realpath: vi.fn(async (path) => {
      if (!usable.has(path)) throw new Error("not found");
      return `/canonical${path}`;
    }),
    stat: vi.fn(async () => ({ isFile: () => true })),
    access: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Codex executable discovery", () => {
  it("uses a usable configured path without searching PATH", async () => {
    const options = discoveryOptions(["/configured/codex"]);

    await expect(
      resolveCodexExecutable({
        ...options,
        configuredPath: "/configured/codex",
      }),
    ).resolves.toEqual({
      executable: "/canonical/configured/codex",
      diagnostics: [],
    });
    expect(options.realpath).toHaveBeenCalledTimes(1);
  });

  it("falls back to PATH and reports one diagnostic when configured path is unavailable", async () => {
    await expect(
      resolveCodexExecutable({
        ...discoveryOptions(["/second/codex"]),
        configuredPath: "/configured/codex",
      }),
    ).resolves.toEqual({
      executable: "/canonical/second/codex",
      diagnostics: [
        {
          code: CODEX_EXECUTABLE_CONFIGURED_PATH_UNAVAILABLE,
          message:
            "Configured Codex executable is unavailable; using Codex found on PATH",
        },
      ],
    });
  });

  it("discovers Codex on PATH when no configured path exists", async () => {
    await expect(
      resolveCodexExecutable(discoveryOptions(["/first/codex"])),
    ).resolves.toMatchObject({
      executable: "/canonical/first/codex",
      diagnostics: [],
    });
  });

  it("rejects with a stable actionable error when no candidate exists", async () => {
    await expect(
      resolveCodexExecutable(discoveryOptions([])),
    ).rejects.toMatchObject({
      name: "CodexExecutableDiscoveryError",
      code: CODEX_EXECUTABLE_NOT_FOUND,
      diagnosticCode: CODEX_EXECUTABLE_NOT_FOUND,
      message: expect.stringContaining("Install Codex"),
    } satisfies Partial<CodexExecutableDiscoveryError>);
  });

  it("does not select non-file PATH entries", async () => {
    await expect(
      resolveCodexExecutable({
        ...discoveryOptions(["/first/codex", "/second/codex"]),
        stat: vi.fn(async (path) => ({
          isFile: () => path.endsWith("second/codex"),
        })),
      }),
    ).resolves.toMatchObject({ executable: "/canonical/second/codex" });
  });

  it("uses PATHEXT with Windows PATH entries", async () => {
    await expect(
      resolveCodexExecutable({
        ...discoveryOptions([String.raw`C:\tools\codex.EXE`], {
          environment: {
            PATH: String.raw`C:\missing;C:\tools`,
            PATHEXT: ".EXE;.CMD",
          },
        }),
        platform: "win32",
        realpath: vi.fn(async (path) => {
          if (path !== String.raw`C:\tools\codex.EXE`)
            throw new Error("not found");
          return String.raw`C:\canonical\codex.EXE`;
        }),
      }),
    ).resolves.toMatchObject({
      executable: String.raw`C:\canonical\codex.EXE`,
    });
  });

  it("does not discover Windows command shims that direct spawning cannot run", async () => {
    await expect(
      resolveCodexExecutable({
        ...discoveryOptions([String.raw`C:\tools\codex.CMD`], {
          environment: {
            PATH: String.raw`C:\tools`,
            PATHEXT: ".EXE;.CMD",
          },
        }),
        platform: "win32",
      }),
    ).rejects.toMatchObject({ code: CODEX_EXECUTABLE_NOT_FOUND });
  });

  it("does not search the current directory for empty POSIX PATH entries", async () => {
    const options = discoveryOptions(["/codex", "/second/codex"], {
      environment: { PATH: ":/second" },
    });

    await expect(resolveCodexExecutable(options)).resolves.toMatchObject({
      executable: "/canonical/second/codex",
    });
    expect(options.realpath).not.toHaveBeenCalledWith("/codex");
  });
});
