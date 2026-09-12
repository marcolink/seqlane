import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Versions whose app-server protocol has been tested by Seqlane. */
export const TESTED_CODEX_VERSIONS = ["0.147.0"] as const;

export interface CodexVersionDiagnostic {
  readonly code: "codex-version-unconfirmed";
  readonly message: string;
  readonly version?: string;
  readonly testedVersions: readonly string[];
}

export function parseCodexVersion(output: string): string | undefined {
  const match = /codex-cli\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][^\s]+)?)/i.exec(
    output,
  );
  return match?.[1];
}

export async function readCodexVersion(
  executable: string,
  cwd: string,
): Promise<string | undefined> {
  try {
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

export function versionDiagnostic(
  version: string | undefined,
): CodexVersionDiagnostic | undefined {
  if (
    version !== undefined &&
    TESTED_CODEX_VERSIONS.includes(version as never)
  ) {
    return undefined;
  }
  const label = version === undefined ? "unknown" : version;
  return {
    code: "codex-version-unconfirmed",
    message: `Codex CLI version ${label} is not in the tested version list; continuing with advisory compatibility only`,
    ...(version === undefined ? {} : { version }),
    testedVersions: TESTED_CODEX_VERSIONS,
  };
}
