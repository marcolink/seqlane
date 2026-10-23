import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, Effect, Exit, Scope } from "effect";

import { ActionResolutionError } from "./errors.js";
import { extractOpenCodeArchive } from "./opencode-archive.js";
import {
  startOpenCodeProcess,
  type OpenCodeProcessOptions,
  type OpenCodeProcessState,
} from "./opencode-process.js";

export interface OpenCodeConnection {
  readonly url: string;
  readonly workspace?: string;
}

export const OPENCODE_VERSION = "1.18.27";
export const OPENCODE_ARCHIVE_SHA256 =
  "4af5494f9433f59db8c1e344198f0ee72a50c06ec009fb4a8aeab4c2d4abd702";
export const OPENCODE_ARCHIVE_URL = `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz`;
export const OPENCODE_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
export const OPENCODE_DOWNLOAD_TIMEOUT_MS = 60_000;
export const OPENCODE_HOST = "127.0.0.1";
export const OPENCODE_PORT = 4096;
export const OPENCODE_SKILL_NAME = "seqlane-git-automation";

export function resolveOpenCodeSkillDirectory(
  actionPath = process.env.GITHUB_ACTION_PATH,
): string {
  assert(actionPath, "GITHUB_ACTION_PATH is required to load resolver skills.");
  return resolve(actionPath, "skills");
}

export function buildOpenCodeConfig(skillDirectory: string): string {
  return JSON.stringify({
    model: "openai/gpt-6.1-sol",
    skills: { paths: [skillDirectory] },
    permission: {
      "*": "deny",
      skill: {
        "*": "deny",
        [OPENCODE_SKILL_NAME]: "allow",
      },
      StructuredOutput: "allow",
      read: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "*.env.example": "allow",
      },
      glob: "allow",
      grep: "allow",
      edit: "allow",
      write: "allow",
      bash: "deny",
      external_directory: "deny",
    },
  });
}

const inheritedRuntimeEnvironmentKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "OPENAI_API_KEY",
] as const;

export function buildOpenCodeChildEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  skillDirectory: string,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of inheritedRuntimeEnvironmentKeys) {
    const value = parent[key];
    if (value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_CONFIG_CONTENT: buildOpenCodeConfig(skillDirectory),
  };
}

export interface OpenCodeRuntimeHandle {
  readonly connection: OpenCodeConnection;
  readonly stop: () => Promise<void>;
}

export interface OpenCodeRuntimeOptions extends OpenCodeProcessOptions {
  readonly onUncertain?: (cause: unknown) => void;
  readonly skillDirectory?: string;
  readonly temporaryParent?: string;
  readonly archiveUrl?: string;
  readonly download?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
}

function runtimeError(message: string, cause?: unknown): ActionResolutionError {
  return new ActionResolutionError("agent", "AGENT_FAILED", message, cause);
}

function promise<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({ try: run, catch: (cause) => cause });
}

export async function downloadOpenCodeArchive(
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(OPENCODE_DOWNLOAD_TIMEOUT_MS);
  const response = await fetch(url, {
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  try {
    if (!response.ok)
      throw new Error(`Archive download failed: ${response.status}`);
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      Number.isSafeInteger(Number(contentLength)) &&
      Number(contentLength) > OPENCODE_ARCHIVE_MAX_BYTES
    ) {
      throw new Error(
        "The OpenCode archive exceeds the maximum download size.",
      );
    }
    if (response.body === null) {
      throw new Error("The OpenCode archive response has no body.");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > OPENCODE_ARCHIVE_MAX_BYTES) {
          throw new Error(
            "The OpenCode archive exceeds the maximum download size.",
          );
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }

    const archive = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      archive.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return archive;
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

export function verifyOpenCodeArchive(archive: Uint8Array): void {
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== OPENCODE_ARCHIVE_SHA256) {
    throw runtimeError("The OpenCode archive hash does not match the pin.");
  }
}

type RuntimeState = OpenCodeProcessState;

function openCodeRuntimeEffect(
  workspace: string,
  options: OpenCodeRuntimeOptions,
  state: RuntimeState,
): Effect.Effect<OpenCodeConnection, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const parent = resolve(options.temporaryParent ?? tmpdir());
    const directory = yield* Effect.acquireRelease(
      promise(() => mkdtemp(join(parent, ".seqlane-opencode-"))),
      (path) =>
        state.safeToDelete
          ? promise(() => rm(path, { recursive: true, force: true })).pipe(
              Effect.catch((cause) =>
                Effect.sync(() => {
                  state.cleanupFailure = cause;
                  state.cleanupFailurePresent = true;
                }),
              ),
            )
          : Effect.void,
    );
    const skillDirectory =
      options.skillDirectory ?? resolveOpenCodeSkillDirectory();
    const archive = yield* promise((signal) =>
      (options.download ?? downloadOpenCodeArchive)(
        options.archiveUrl ?? OPENCODE_ARCHIVE_URL,
        signal,
      ),
    );
    verifyOpenCodeArchive(archive);
    const archivePath = join(directory, "opencode.tar.gz");
    yield* Effect.uninterruptible(
      promise((signal) =>
        writeFile(archivePath, archive, { flag: "wx", signal }),
      ),
    );
    yield* extractOpenCodeArchive(archivePath, directory, state);
    const executable = join(directory, "opencode");
    yield* startOpenCodeProcess(
      executable,
      resolve(workspace),
      [
        "serve",
        "--hostname",
        OPENCODE_HOST,
        "--port",
        String(OPENCODE_PORT),
        "--print-logs",
      ],
      buildOpenCodeChildEnvironment(process.env, skillDirectory),
      `http://${OPENCODE_HOST}:${OPENCODE_PORT}/global/health`,
      options,
      state,
    );
    return {
      url: `http://${OPENCODE_HOST}:${OPENCODE_PORT}`,
      workspace: resolve(workspace),
    };
  });
}

export class NodeOpenCodeRuntime {
  private readonly options: OpenCodeRuntimeOptions;

  constructor(options: OpenCodeRuntimeOptions = {}) {
    this.options = options;
  }

  async start(
    workspace: string,
    shutdownSignal?: AbortSignal,
  ): Promise<OpenCodeRuntimeHandle> {
    const scope = Effect.runSync(Scope.make("sequential"));
    const state: RuntimeState = { safeToDelete: true };
    let connection: OpenCodeConnection;
    try {
      connection = await Effect.runPromise(
        Effect.provideService(
          openCodeRuntimeEffect(workspace, this.options, state),
          Scope.Scope,
          scope,
        ),
        shutdownSignal === undefined ? undefined : { signal: shutdownSignal },
      );
    } catch (cause: unknown) {
      const cleanupExit = await Effect.runPromiseExit(
        Scope.close(scope, Exit.fail(cause)),
      );
      if (!state.safeToDelete) this.options.onUncertain?.(state.cleanupFailure);
      if (state.cleanupFailurePresent === true) {
        throw runtimeError(
          "OpenCode could not start and its cleanup could not be confirmed.",
          new AggregateError(
            [cause, state.cleanupFailure],
            "OpenCode startup and cleanup both failed.",
            { cause },
          ),
        );
      }
      if (Exit.isFailure(cleanupExit)) {
        throw runtimeError(
          "OpenCode could not be started or cleaned up.",
          Cause.squash(cleanupExit.cause),
        );
      }
      if (cause instanceof ActionResolutionError) throw cause;
      throw runtimeError("OpenCode could not be started.", cause);
    }
    let stopPromise: Promise<void> | undefined;
    return {
      connection,
      stop: () => {
        if (stopPromise !== undefined) return stopPromise;
        stopPromise = (async () => {
          try {
            await Effect.runPromise(Scope.close(scope, Exit.void));
          } finally {
            if (!state.safeToDelete)
              this.options.onUncertain?.(state.cleanupFailure);
          }
          if (state.cleanupFailurePresent === true) {
            throw runtimeError(
              "OpenCode could not be stopped and its files were retained.",
              state.cleanupFailure,
            );
          }
        })();
        return stopPromise;
      },
    };
  }
}
