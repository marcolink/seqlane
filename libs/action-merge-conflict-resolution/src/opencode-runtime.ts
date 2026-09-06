import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { ActionResolutionError } from "./errors.js";

export interface OpenCodeConnection {
  readonly url: string;
  readonly workspace?: string;
}

export const OPENCODE_VERSION = "1.18.27";
export const OPENCODE_ARCHIVE_SHA256 =
  "4af5494f9433f59db8c1e344198f0ee72a50c06ec009fb4a8aeab4c2d4abd702";
export const OPENCODE_ARCHIVE_URL = `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz`;
export const OPENCODE_HOST = "127.0.0.1";
export const OPENCODE_PORT = 4096;
export const OPENCODE_CONFIG =
  '{"model":"openai/gpt-5.6-terra","permission":{"*":"deny","StructuredOutput":"allow","read":{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"allow"},"glob":"allow","grep":"allow","edit":"allow","write":"allow","bash":"deny","external_directory":"deny"}}';

export interface OpenCodeRuntimeHandle {
  readonly connection: OpenCodeConnection;
  readonly stop: () => Promise<void>;
}

export interface OpenCodeRuntimeOptions {
  readonly temporaryParent?: string;
  readonly archiveUrl?: string;
  readonly download?: (url: string) => Promise<Uint8Array>;
  readonly start?: (
    executable: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    },
  ) => ChildProcess;
  readonly healthcheck?: (url: string) => Promise<boolean>;
  readonly readinessTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

function runtimeError(message: string, cause?: unknown): ActionResolutionError {
  return new ActionResolutionError("agent", "AGENT_FAILED", message, cause);
}

async function downloadArchive(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Archive download failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export function verifyOpenCodeArchive(archive: Uint8Array): void {
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== OPENCODE_ARCHIVE_SHA256) {
    throw runtimeError("The OpenCode archive hash does not match the pin.");
  }
}

function defaultStart(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  },
): ChildProcess {
  return spawn(executable, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: "ignore",
    windowsHide: true,
  });
}

function defaultHealthcheck(url: string): Promise<boolean> {
  return fetch(url, { signal: AbortSignal.timeout(2_000) })
    .then((response) => response.ok)
    .catch(() => false);
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => {
    const timeout = setTimeout(resolveExit, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

async function extractArchive(
  archivePath: string,
  directory: string,
): Promise<void> {
  await new Promise<void>((resolveExtract, rejectExtract) => {
    execFile(
      "tar",
      ["--extract", "--gzip", "--file", archivePath, "--directory", directory],
      { cwd: directory, maxBuffer: 1024 * 1024 },
      (error) => (error === null ? resolveExtract() : rejectExtract(error)),
    );
  });
}

export class NodeOpenCodeRuntime {
  private readonly options: OpenCodeRuntimeOptions;

  constructor(options: OpenCodeRuntimeOptions = {}) {
    this.options = options;
  }

  async start(workspace: string): Promise<OpenCodeRuntimeHandle> {
    const parent = resolve(this.options.temporaryParent ?? tmpdir());
    const directory = await mkdtemp(join(parent, ".seqlane-opencode-"));
    let child: ChildProcess | undefined;
    try {
      const archive = await (this.options.download ?? downloadArchive)(
        this.options.archiveUrl ?? OPENCODE_ARCHIVE_URL,
      );
      verifyOpenCodeArchive(archive);
      const archivePath = join(directory, "opencode.tar.gz");
      await writeFile(archivePath, archive, { flag: "wx" });
      await mkdir(directory, { recursive: true });
      await extractArchive(archivePath, directory);
      const executable = join(directory, "opencode");
      child = (this.options.start ?? defaultStart)(
        executable,
        [
          "serve",
          "--hostname",
          OPENCODE_HOST,
          "--port",
          String(OPENCODE_PORT),
          "--print-logs",
        ],
        {
          cwd: resolve(workspace),
          env: {
            OPENCODE_DISABLE_PROJECT_CONFIG: "true",
            OPENCODE_CONFIG_CONTENT: OPENCODE_CONFIG,
          },
        },
      );
      const healthcheck = this.options.healthcheck ?? defaultHealthcheck;
      const timeout = this.options.readinessTimeoutMs ?? 120_000;
      const interval = this.options.pollIntervalMs ?? 1_000;
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeout) {
        if (
          await healthcheck(
            `http://${OPENCODE_HOST}:${OPENCODE_PORT}/global/health`,
          )
        ) {
          let stopped = false;
          return {
            connection: {
              url: `http://${OPENCODE_HOST}:${OPENCODE_PORT}`,
              workspace: resolve(workspace),
            },
            stop: async () => {
              if (stopped) return;
              stopped = true;
              const processHandle = child;
              if (processHandle === undefined) {
                await rm(directory, { recursive: true, force: true });
                return;
              }
              if (processHandle.exitCode === null)
                processHandle.kill("SIGTERM");
              await waitForExit(processHandle);
              if (processHandle.exitCode === null) {
                processHandle.kill("SIGKILL");
                await waitForExit(processHandle, 1_000);
              }
              await rm(directory, { recursive: true, force: true });
            },
          };
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, interval));
      }
      throw runtimeError("OpenCode did not become ready before the timeout.");
    } catch (error: unknown) {
      if (child?.exitCode === null) child.kill("SIGTERM");
      if (child !== undefined) await waitForExit(child);
      if (child?.exitCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child, 1_000);
      }
      await rm(directory, { recursive: true, force: true });
      if (error instanceof ActionResolutionError) throw error;
      throw runtimeError("OpenCode could not be started.", error);
    }
  }
}
