import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RELEASE_API_URL =
  "https://api.github.com/repos/anomalyco/opencode/releases/tags";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchReleaseMetadata(
  version: string,
  token?: string,
  fetchImplementation: FetchLike = fetch,
): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "seqlane-setup-opencode-action",
  };
  if (token !== undefined && token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetchImplementation(`${RELEASE_API_URL}/v${version}`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(
      `OpenCode release metadata request failed with HTTP ${response.status}.`,
    );
  }
  return response.json();
}

export type ExecutableRunner = (
  executable: string,
  args: string[],
) => Promise<{ stdout: string }>;

const runExecutable: ExecutableRunner = async (executable, args) => {
  const result = await execFileAsync(executable, args, {
    encoding: "utf8",
    maxBuffer: 1_048_576,
    windowsHide: true,
  });
  return { stdout: result.stdout };
};

export async function verifyExecutableVersion(
  executable: string,
  version: string,
  runner: ExecutableRunner = runExecutable,
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await runner(executable, ["--version"]));
  } catch (error) {
    throw new Error(
      `OpenCode executable could not report its version: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stdout.trim() !== version) {
    throw new Error(
      `OpenCode executable reported ${JSON.stringify(stdout.trim())}; expected ${version}.`,
    );
  }
}
