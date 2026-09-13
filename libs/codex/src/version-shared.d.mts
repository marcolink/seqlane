export declare const TESTED_CODEX_VERSIONS: readonly string[];

export interface CodexVersionDiagnostic {
  readonly code: "codex-version-unconfirmed";
  readonly message: string;
  readonly version?: string;
  readonly testedVersions: readonly string[];
}

export declare function parseCodexVersion(output: string): string | undefined;

export declare function readCodexVersion(
  executable: string,
  cwd: string,
): Promise<string | undefined>;

export declare function versionDiagnostic(
  version: string | undefined,
): CodexVersionDiagnostic | undefined;
