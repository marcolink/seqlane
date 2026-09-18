import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { posix, win32 } from "node:path";
import { CodexAdapterError } from "./errors.js";

const CODEX_COMMAND = "codex";
const DEFAULT_WINDOWS_PATH_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

export const CODEX_EXECUTABLE_CONFIGURED_PATH_UNAVAILABLE =
  "codex.executable.configured-path-unavailable";
export const CODEX_EXECUTABLE_NOT_FOUND = "codex.executable.not-found";

export interface CodexExecutableDiagnostic {
  readonly code: typeof CODEX_EXECUTABLE_CONFIGURED_PATH_UNAVAILABLE;
  readonly message: string;
}

export interface CodexExecutableDiscoveryResult {
  readonly executable: string;
  readonly diagnostics: readonly CodexExecutableDiagnostic[];
}

interface FileStatus {
  isFile(): boolean;
}

export interface CodexExecutableDiscoveryOptions {
  readonly configuredPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly realpath?: (path: string) => Promise<string>;
  readonly stat?: (path: string) => Promise<FileStatus>;
  readonly access?: (path: string, mode: number) => Promise<void>;
}

export class CodexExecutableDiscoveryError extends CodexAdapterError {
  constructor(
    readonly diagnosticCode: typeof CODEX_EXECUTABLE_NOT_FOUND,
    message: string,
  ) {
    super(diagnosticCode, message);
    this.name = "CodexExecutableDiscoveryError";
  }
}

/** Resolves one executable before any version or protocol validation begins. */
export async function resolveCodexExecutable(
  options: CodexExecutableDiscoveryOptions = {},
): Promise<CodexExecutableDiscoveryResult> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const usable = createUsableExecutableCheck(options);
  const configuredPath = options.configuredPath;

  if (configuredPath !== undefined) {
    const configured = await usable(configuredPath);
    if (configured !== undefined) {
      return { executable: configured, diagnostics: [] };
    }
  }

  const fromPath = await findOnPath(environment, platform, usable);
  if (fromPath !== undefined) {
    return {
      executable: fromPath,
      diagnostics:
        configuredPath === undefined
          ? []
          : [
              {
                code: CODEX_EXECUTABLE_CONFIGURED_PATH_UNAVAILABLE,
                message:
                  "Configured Codex executable is unavailable; using Codex found on PATH",
              },
            ],
    };
  }

  throw new CodexExecutableDiscoveryError(
    CODEX_EXECUTABLE_NOT_FOUND,
    configuredPath === undefined
      ? "Codex executable was not found. Install Codex, add it to PATH, or configure an absolute executable path"
      : "Configured Codex executable is unavailable and Codex was not found on PATH. Install Codex, add it to PATH, or update the configured executable path",
  );
}

function createUsableExecutableCheck(
  options: CodexExecutableDiscoveryOptions,
): (candidate: string) => Promise<string | undefined> {
  const resolveRealPath = options.realpath ?? realpath;
  const readStatus = options.stat ?? stat;
  const checkAccess = options.access ?? access;
  return async (candidate) => {
    try {
      const resolved = await resolveRealPath(candidate);
      const status = await readStatus(resolved);
      if (!status.isFile()) return undefined;
      await checkAccess(resolved, constants.X_OK);
      return resolved;
    } catch {
      return undefined;
    }
  };
}

async function findOnPath(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  usable: (candidate: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const pathValue = environment.PATH;
  if (pathValue === undefined || pathValue.length === 0) return undefined;

  const isWindows = platform === "win32";
  const path = isWindows ? win32 : posix;
  const extensions = isWindows
    ? windowsPathExtensions(environment.PATHEXT)
    : [""];
  for (const entry of pathValue.split(isWindows ? ";" : ":")) {
    if (entry.length === 0) continue;
    for (const extension of extensions) {
      const executable = await usable(
        path.join(entry, `${CODEX_COMMAND}${extension}`),
      );
      if (executable !== undefined) return executable;
    }
  }
  return undefined;
}

function windowsPathExtensions(pathExtensions: string | undefined): string[] {
  if (pathExtensions === undefined || pathExtensions.length === 0) {
    return DEFAULT_WINDOWS_PATH_EXTENSIONS;
  }
  const extensions = pathExtensions
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
  return extensions.length === 0 ? DEFAULT_WINDOWS_PATH_EXTENSIONS : extensions;
}
