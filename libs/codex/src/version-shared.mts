import { promisify } from "node:util";
import testedVersions from "../tested-versions.json" with { type: "json" };

const VERSION_PATTERN = /codex-cli\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][^\s]+)?)/i;
const MAX_DIAGNOSTIC_LENGTH = 512;

function removeControlCharacters(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(
        (codePoint >= 0 && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      );
    })
    .join("");
}

export const TESTED_CODEX_VERSIONS = testedVersions;

export function parseCodexVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output)?.[1];
}

export async function readCodexVersion(
  executable: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const { execFile } = await import("node:child_process");
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync(executable, ["--version"], {
      cwd,
      timeout: 3_000,
      maxBuffer: 16_384,
      ...(signal === undefined ? {} : { signal }),
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
  const safeVersion =
    version === undefined ? undefined : removeControlCharacters(version);
  const boundedVersion =
    safeVersion === undefined || safeVersion.length === 0
      ? undefined
      : safeVersion.length > MAX_DIAGNOSTIC_LENGTH
        ? `${safeVersion.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`
        : safeVersion;
  const label = boundedVersion ?? "unknown";
  const message = `Codex CLI version ${label} is not in the tested version list; continuing with advisory compatibility only`;
  return {
    code: "codex-version-unconfirmed",
    message:
      message.length > MAX_DIAGNOSTIC_LENGTH
        ? `${message.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`
        : message,
    ...(boundedVersion === undefined ? {} : { version: boundedVersion }),
    testedVersions: TESTED_CODEX_VERSIONS,
  };
}
