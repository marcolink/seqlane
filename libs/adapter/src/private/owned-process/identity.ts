import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Cause, Effect, Exit, Option } from "effect";
import { z } from "zod";
import {
  ownedProcessIdentitySchema,
  type OwnedProcessIdentity,
} from "@seqlane/protocol/private/owned-process";

const execFile = promisify(execFileCallback);
const PROCESS_QUERY_LIMIT = 64 * 1024;
const PROCESS_QUERY_DEADLINE = "1 second";
const TERMINATION_DEADLINE = "1500 millis";
const POLL_INTERVAL = "50 millis";
const pidSchema = z.number().int().positive().safe();
const processRowSchema = z
  .object({
    pid: z.number().int().nonnegative().safe(),
    processGroupId: z.number().int().nonnegative().safe(),
    state: z.string().min(1),
  })
  .strict();
const windowsIdentitySchema = z
  .object({
    ProcessId: pidSchema,
    CreationDate: z.string().min(1),
  })
  .strict();
const missingProcessErrorSchema = z.object({ code: z.literal("ENOENT") });
const missingDarwinProcessErrorSchema = z.object({
  code: z.literal(1),
  stdout: z.literal(""),
  stderr: z.literal(""),
});
const missingGroupErrorSchema = z.object({ code: z.literal("ESRCH") });

type ProcessRow = z.infer<typeof processRowSchema>;
type ProcessParts = {
  readonly processGroupId: number;
  readonly birthIdentity: string;
};

export class OwnedProcessIdentityError extends Error {
  readonly code = "OWNED_PROCESS_IDENTITY_UNAVAILABLE";

  constructor(cause: unknown) {
    super("Could not verify owned process identity", { cause });
    this.name = "OwnedProcessIdentityError";
  }
}

function platform(): OwnedProcessIdentity["platform"] {
  if (
    process.platform === "linux" ||
    process.platform === "darwin" ||
    process.platform === "win32"
  ) {
    return process.platform;
  }
  throw new OwnedProcessIdentityError(
    new Error(`Unsupported process platform: ${process.platform}`),
  );
}

const processEffect = <A>(operation: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof OwnedProcessIdentityError
        ? cause
        : new OwnedProcessIdentityError(cause),
  }).pipe(Effect.timeout(PROCESS_QUERY_DEADLINE));

async function runBoundary<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (
    Option.isSome(failure) &&
    failure.value instanceof OwnedProcessIdentityError
  ) {
    throw failure.value;
  }
  throw new OwnedProcessIdentityError(Cause.squash(exit.cause));
}

function parseLinuxStat(text: string, pid: number): ProcessParts {
  const commandEnd = text.lastIndexOf(")");
  if (commandEnd < 0)
    throw new OwnedProcessIdentityError(
      new Error("Malformed Linux process stat"),
    );
  const fields = text
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const processId = Number(text.slice(0, text.indexOf(" ")));
  const parsedGroupId = Number(fields[2]);
  const birthIdentity = fields[19];
  const groupId = pidSchema.safeParse(parsedGroupId);
  if (
    processId !== pid ||
    !groupId.success ||
    !birthIdentity ||
    !/^\d+$/.test(birthIdentity)
  ) {
    throw new OwnedProcessIdentityError(
      new Error("Incomplete Linux process stat"),
    );
  }
  return { processGroupId: groupId.data, birthIdentity };
}

function inspectLinux(
  pid: number,
  signal: AbortSignal,
): Promise<ProcessParts | undefined> {
  return readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal })
    .then((stat) => parseLinuxStat(stat, pid))
    .catch((cause: unknown) => {
      if (missingProcessErrorSchema.safeParse(cause).success) return undefined;
      throw cause;
    });
}

async function inspectDarwin(
  pid: number,
  signal: AbortSignal,
): Promise<ProcessParts | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(
      "ps",
      ["-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-p", String(pid)],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        env: { ...process.env, LC_ALL: "C" },
        signal,
      },
    ));
  } catch (cause) {
    if (missingDarwinProcessErrorSchema.safeParse(cause).success)
      return undefined;
    throw cause;
  }
  const output = stdout.trim();
  if (output.length === 0) return undefined;
  const match = output.match(/^(\d+)\s+(\d+)\s+(.+)$/);
  const parsedPid = Number(match?.[1]);
  const groupId = pidSchema.safeParse(Number(match?.[2]));
  const birthIdentity = match?.[3]?.trim();
  if (parsedPid !== pid || !groupId.success || !birthIdentity) {
    throw new OwnedProcessIdentityError(
      new Error("Incomplete Darwin process metadata"),
    );
  }
  return { processGroupId: groupId.data, birthIdentity };
}

async function inspectWindows(
  pid: number,
  signal: AbortSignal,
): Promise<ProcessParts | undefined> {
  // PID is a validated positive integer before it enters this fixed PowerShell expression.
  const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($null -eq $p -or $null -eq $p.CreationDate) { 'null' } else { [pscustomobject]@{ ProcessId=[int]$p.ProcessId; CreationDate=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`;
  const { stdout } = await execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", maxBuffer: 16 * 1024, windowsHide: true, signal },
  );
  const raw: unknown = JSON.parse(stdout);
  if (raw === null) return undefined;
  const parsed = windowsIdentitySchema.safeParse(raw);
  if (!parsed.success || parsed.data.ProcessId !== pid) {
    throw new OwnedProcessIdentityError(
      new Error("Incomplete Windows process metadata", { cause: parsed.error }),
    );
  }
  return { processGroupId: pid, birthIdentity: parsed.data.CreationDate };
}

function inspect(
  pid: number,
  signal: AbortSignal,
): Promise<ProcessParts | undefined> {
  if (process.platform === "linux") return inspectLinux(pid, signal);
  if (process.platform === "darwin") return inspectDarwin(pid, signal);
  if (process.platform === "win32") return inspectWindows(pid, signal);
  return Promise.reject(
    new Error(`Unsupported process platform: ${process.platform}`),
  );
}

function parsePsRows(stdout: string): ProcessRow[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return processRowSchema.parse({
        pid: Number(parts[0]),
        processGroupId: Number(parts[1]),
        state: parts[2],
      });
    });
}

async function posixGroupRows(
  pgid: number,
  signal: AbortSignal,
): Promise<ProcessRow[]> {
  const { stdout } = await execFile("ps", ["-eo", "pid=,pgid=,stat="], {
    encoding: "utf8",
    maxBuffer: PROCESS_QUERY_LIMIT,
    env: { ...process.env, LC_ALL: "C" },
    signal,
  });
  return parsePsRows(stdout).filter((row) => row.processGroupId === pgid);
}

function hasActiveProcesses(rows: readonly ProcessRow[]): boolean {
  return rows.some(
    (row) => !row.state.startsWith("Z") && !row.state.startsWith("X"),
  );
}

function confirmPosixGroupStopped(processGroupId: number) {
  return processEffect(async (signal) => {
    const rows = await posixGroupRows(processGroupId, signal);
    return !hasActiveProcesses(rows);
  });
}

function stopped(
  identity: OwnedProcessIdentity,
): Effect.Effect<boolean, OwnedProcessIdentityError | Cause.TimeoutError> {
  if (identity.platform === "win32") return Effect.succeed(false);
  return confirmPosixGroupStopped(identity.processGroupId);
}

function makeIdentity(
  pid: number,
  details: ProcessParts,
): OwnedProcessIdentity {
  const parsed = ownedProcessIdentitySchema.safeParse({
    version: 1,
    pid,
    processGroupId: details.processGroupId,
    platform: platform(),
    birthIdentity: details.birthIdentity,
  });
  if (!parsed.success) {
    throw new OwnedProcessIdentityError(
      new Error("Process is not an owned detached group leader", {
        cause: parsed.error,
      }),
    );
  }
  return parsed.data;
}

export function captureOwnedProcessIdentity(
  pid: number,
): Promise<OwnedProcessIdentity> {
  return runBoundary(
    Effect.gen(function* () {
      const parsedPid = pidSchema.safeParse(pid);
      if (!parsedPid.success) {
        return yield* Effect.fail(
          new OwnedProcessIdentityError(
            new Error("Invalid process id", { cause: parsedPid.error }),
          ),
        );
      }
      const details = yield* processEffect((signal) =>
        inspect(parsedPid.data, signal),
      );
      if (details === undefined) {
        return yield* Effect.fail(
          new OwnedProcessIdentityError(new Error("Process no longer exists")),
        );
      }
      return makeIdentity(parsedPid.data, details);
    }),
  );
}

export function isOwnedProcessIdentityCurrent(
  identity: OwnedProcessIdentity,
): Promise<boolean> {
  return runBoundary(
    Effect.gen(function* () {
      const parsed = ownedProcessIdentitySchema.safeParse(identity);
      if (!parsed.success || parsed.data.platform !== process.platform)
        return false;
      const current = yield* processEffect((signal) =>
        inspect(parsed.data.pid, signal),
      );
      return (
        current !== undefined &&
        current.processGroupId === parsed.data.processGroupId &&
        current.birthIdentity === parsed.data.birthIdentity
      );
    }),
  );
}

export function confirmOwnedProcessStopped(
  identity: OwnedProcessIdentity,
): Promise<boolean> {
  return runBoundary(
    Effect.gen(function* () {
      const parsed = ownedProcessIdentitySchema.safeParse(identity);
      if (!parsed.success || parsed.data.platform !== process.platform)
        return false;
      return yield* stopped(parsed.data);
    }),
  );
}

/** Read-only proof that a positive PID used as a POSIX process-group ID has no active members. */
export function confirmOwnedProcessGroupStopped(pid: number): Promise<boolean> {
  return runBoundary(
    Effect.gen(function* () {
      const parsedPid = pidSchema.safeParse(pid);
      if (!parsedPid.success) {
        return yield* Effect.fail(
          new OwnedProcessIdentityError(
            new Error("Invalid process group id", { cause: parsedPid.error }),
          ),
        );
      }
      if (process.platform === "win32") return false;
      const groupIsStopped = yield* confirmPosixGroupStopped(parsedPid.data);
      return groupIsStopped;
    }),
  );
}

export function terminateOwnedProcess(
  identity: OwnedProcessIdentity,
  signal: "SIGTERM" | "SIGKILL",
): Promise<{ confirmed: boolean }> {
  return runBoundary(
    Effect.gen(function* () {
      const parsed = ownedProcessIdentitySchema.safeParse(identity);
      if (!parsed.success || parsed.data.platform !== process.platform)
        return { confirmed: false };
      const current = yield* processEffect((abort) =>
        inspect(parsed.data.pid, abort),
      );
      if (
        current === undefined ||
        current.processGroupId !== parsed.data.processGroupId ||
        current.birthIdentity !== parsed.data.birthIdentity
      ) {
        if (
          current !== undefined &&
          (current.processGroupId !== parsed.data.processGroupId ||
            current.birthIdentity !== parsed.data.birthIdentity)
        ) {
          return { confirmed: false };
        }
        if (parsed.data.platform === "win32") return { confirmed: false };
        return {
          confirmed: yield* confirmPosixGroupStopped(
            parsed.data.processGroupId,
          ),
        };
      }
      if (parsed.data.platform === "win32") {
        yield* processEffect(async (abort) => {
          await execFile(
            "taskkill.exe",
            [
              "/T",
              "/PID",
              String(parsed.data.pid),
              ...(signal === "SIGKILL" ? ["/F"] : []),
            ],
            {
              encoding: "utf8",
              maxBuffer: 16 * 1024,
              windowsHide: true,
              signal: abort,
            },
          );
        });
        // CIM cannot prove the fate of descendants after Windows reparents them.
        return { confirmed: false };
      }
      const signaled = yield* processEffect(async () => {
        try {
          process.kill(-parsed.data.processGroupId, signal);
          return true;
        } catch (cause) {
          if (missingGroupErrorSchema.safeParse(cause).success) return false;
          throw cause;
        }
      });
      if (!signaled) {
        return {
          confirmed: yield* confirmPosixGroupStopped(
            parsed.data.processGroupId,
          ),
        };
      }
      const wait = Effect.gen(function* () {
        while (true) {
          if (yield* stopped(parsed.data)) return true;
          yield* Effect.sleep(POLL_INTERVAL);
        }
      }).pipe(Effect.timeoutOption(TERMINATION_DEADLINE));
      const result = yield* wait;
      return { confirmed: Option.isSome(result) && result.value };
    }),
  );
}
