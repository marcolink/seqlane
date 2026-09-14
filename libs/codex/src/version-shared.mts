import { promisify } from "node:util";
import testedVersions from "../tested-versions.json" with { type: "json" };

const VERSION_PATTERN = /codex-cli\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][^\s]+)?)/i;

export const TESTED_CODEX_VERSIONS = testedVersions;

export function parseCodexVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output)?.[1];
}

export async function readCodexVersion(
  executable: string,
  cwd: string,
): Promise<string | undefined> {
  try {
    const { execFile } = await import("node:child_process");
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync(executable, ["--version"], {
      cwd,
      timeout: 3_000,
      maxBuffer: 16_384,
    });
    return parseCodexVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    return undefined;
  }
}

export interface CodexVersionDiagnostic {
  readonly code: "codex-version-unconfirmed";
  readonly message: string;
  readonly version?: string;
  readonly testedVersions: readonly string[];
}

export function versionDiagnostic(
  version: string | undefined,
): CodexVersionDiagnostic | undefined {
  if (version !== undefined && TESTED_CODEX_VERSIONS.includes(version))
    return undefined;
  const label = version === undefined ? "unknown" : version;
  return {
    code: "codex-version-unconfirmed",
    message: `Codex CLI version ${label} is not in the tested version list; continuing with advisory compatibility only`,
    ...(version === undefined ? {} : { version }),
    testedVersions: TESTED_CODEX_VERSIONS,
  };
}
