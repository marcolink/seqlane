import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Effect } from "effect";
import { z } from "zod";

import { ServiceLifecycleError } from "./errors.js";
import { processIdentitySchema, type ProcessIdentity } from "./schemas.js";

const execFileAsync = promisify(execFile);
const positiveIntegerSchema = z.number().int().positive();

function positiveInteger(value: unknown): number | undefined {
  const parsed = positiveIntegerSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function positiveIntegerFromText(
  value: string | undefined,
): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return positiveInteger(Number(value));
}

function errorCode(value: unknown): string | undefined {
  if (!(value instanceof Error) || !("code" in value)) return undefined;
  const parsed = z.string().safeParse(value.code);
  return parsed.success ? parsed.data : undefined;
}

function parseLinuxProcessIdentity(contents: string): ProcessIdentity {
  const commandEnd = contents.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("Invalid Linux process metadata");
  const fields = contents
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const processGroupId = positiveIntegerFromText(fields[2]);
  const processStartTime = fields[19];
  const parsed = processIdentitySchema.safeParse({
    processGroupId,
    processStartTime,
  });
  if (!parsed.success) throw new Error("Incomplete Linux process metadata");
  return parsed.data;
}

function readProcessIdentityFromPs(pid: number) {
  return Effect.tryPromise({
    try: (signal) =>
      execFileAsync(
        "ps",
        ["-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-p", String(pid)],
        { maxBuffer: 16 * 1024, signal },
      ),
    catch: (cause) =>
      new ServiceLifecycleError(`Could not inspect process ${pid}`, cause),
  }).pipe(
    Effect.flatMap(({ stdout }) => {
      const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      const parsed = processIdentitySchema.safeParse({
        processGroupId: positiveIntegerFromText(match?.[2]),
        processStartTime: match?.[3]?.trim(),
      });
      return parsed.success
        ? Effect.succeed(parsed.data)
        : Effect.fail(
            new ServiceLifecycleError(
              `Could not verify process ${pid}`,
              new Error("Incomplete process metadata"),
            ),
          );
    }),
    Effect.timeout("2 seconds"),
    Effect.catch((cause) =>
      Effect.fail(
        new ServiceLifecycleError(`Could not inspect process ${pid}`, cause),
      ),
    ),
  );
}

export function readProcessIdentity(
  value: unknown,
): Effect.Effect<ProcessIdentity | undefined, ServiceLifecycleError> {
  const pid = positiveInteger(value);
  if (!pid) return Effect.succeed(undefined);
  if (process.platform === "linux") {
    return Effect.tryPromise({
      try: (signal) =>
        readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal }),
      catch: (cause) =>
        new ServiceLifecycleError(`Could not inspect process ${pid}`, cause),
    }).pipe(
      Effect.timeout("2 seconds"),
      Effect.catch((cause) =>
        Effect.fail(
          new ServiceLifecycleError(`Could not inspect process ${pid}`, cause),
        ),
      ),
      Effect.flatMap((contents) =>
        Effect.try({
          try: () => parseLinuxProcessIdentity(contents),
          catch: (cause) =>
            new ServiceLifecycleError(`Could not verify process ${pid}`, cause),
        }),
      ),
    );
  }
  if (process.platform === "darwin") return readProcessIdentityFromPs(pid);
  return Effect.succeed(undefined);
}

export function processIdentityMatches(pid: number, expected: ProcessIdentity) {
  return readProcessIdentity(pid).pipe(
    Effect.map(
      (current) =>
        current?.processGroupId === expected.processGroupId &&
        current.processStartTime === expected.processStartTime,
    ),
    Effect.catch(() => Effect.succeed(false)),
  );
}

export function processGroupIsActive(processGroupId: number) {
  return Effect.tryPromise({
    try: (signal) =>
      execFileAsync("ps", ["-eo", "pgid=,stat="], {
        maxBuffer: 1024 * 1024,
        signal,
      }),
    catch: (cause) =>
      new ServiceLifecycleError("Could not inspect process group", cause),
  }).pipe(
    Effect.timeout("2 seconds"),
    Effect.catch((cause) =>
      Effect.fail(
        new ServiceLifecycleError("Could not inspect process group", cause),
      ),
    ),
    Effect.map(({ stdout }) =>
      stdout.split(/\r?\n/).some((line) => {
        const match = line.trim().match(/^(\d+)\s+(\S+)/);
        const groupId = positiveIntegerFromText(match?.[1]);
        const state = match?.[2];
        return (
          groupId === processGroupId &&
          state !== undefined &&
          !/[ZzXx]/.test(state)
        );
      }),
    ),
  );
}

export function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMilliseconds: number,
) {
  const wait = Effect.gen(function* () {
    while (yield* processGroupIsActive(processGroupId)) {
      yield* Effect.sleep(100);
    }
    return true;
  });
  return Effect.timeoutOption(wait, timeoutMilliseconds).pipe(
    Effect.flatMap((result) =>
      result._tag === "Some"
        ? Effect.succeed(true)
        : Effect.sleep(50).pipe(
            Effect.andThen(processGroupIsActive(processGroupId)),
            Effect.map((active) => !active),
          ),
    ),
  );
}

export function isMissingProcess(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ESRCH" || code === "EINVAL";
}
