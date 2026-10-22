import { spawn, type ChildProcess } from "node:child_process";
import { Effect, Exit, Fiber } from "effect";
import { z } from "zod";

import { anchorAdoptRequestSchema } from "./schemas.js";

const argumentsSchema = z.tuple([z.string().min(1), z.string()]);
const serviceArgumentsSchema = z.array(z.string());
const spawnOptions = {
  cwd: process.cwd(),
  env: process.env,
  windowsHide: true,
};

function send(message: unknown) {
  return Effect.callback<void, Error>((resume, signal) => {
    if (!process.connected || typeof process.send !== "function") {
      resume(Effect.fail(new Error("Process anchor IPC is disconnected")));
      return;
    }
    const onDisconnect = () =>
      resume(
        Effect.fail(new Error("Process anchor IPC disconnected while sending")),
      );
    process.once("disconnect", onDisconnect);
    signal.addEventListener(
      "abort",
      () => process.off("disconnect", onDisconnect),
      { once: true },
    );
    process.send(message, (error) => {
      process.off("disconnect", onDisconnect);
      if (error) resume(Effect.fail(error));
      else resume(Effect.void);
    });
  });
}

function waitForSpawn(child: ChildProcess) {
  return Effect.callback<void, Error>((resume, signal) => {
    const onSpawn = () => finish(Effect.void);
    const onError = (error: Error) => finish(Effect.fail(error));
    const finish = (effect: Effect.Effect<void, Error>) => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      resume(effect);
    };
    const onAbort = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      child.kill("SIGKILL");
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForAdoption() {
  return Effect.callback<"adopted" | "disconnected", never>(
    (resume, signal) => {
      const onMessage = (value: unknown) => {
        const message = anchorAdoptRequestSchema.safeParse(value);
        if (!message.success) return;
        process.off("message", onMessage);
        process.off("disconnect", onDisconnect);
        signal.removeEventListener("abort", onAbort);
        resume(Effect.succeed("adopted"));
      };
      const onDisconnect = () => {
        process.off("message", onMessage);
        process.off("disconnect", onDisconnect);
        signal.removeEventListener("abort", onAbort);
        resume(Effect.succeed("disconnected"));
      };
      const onAbort = () => {
        process.off("message", onMessage);
        process.off("disconnect", onDisconnect);
      };
      process.on("message", onMessage);
      process.once("disconnect", onDisconnect);
      signal.addEventListener("abort", onAbort, { once: true });
      if (!process.connected) onDisconnect();
    },
  );
}

function waitForParentDisconnect() {
  return Effect.callback<void, never>((resume, signal) => {
    const onDisconnect = () => {
      process.off("disconnect", onDisconnect);
      signal.removeEventListener("abort", onAbort);
      resume(Effect.void);
    };
    const onAbort = () => process.off("disconnect", onDisconnect);
    process.once("disconnect", onDisconnect);
    signal.addEventListener("abort", onAbort, { once: true });
    if (!process.connected) onDisconnect();
  });
}

function waitForServiceExit(child: ChildProcess) {
  return Effect.callback<
    { code: number | null; signal: NodeJS.Signals | null },
    never
  >((resume, abort) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      child.off("exit", onExit);
      abort.removeEventListener("abort", onAbort);
      resume(Effect.succeed({ code, signal }));
    };
    const onAbort = () => child.off("exit", onExit);
    child.once("exit", onExit);
    abort.addEventListener("abort", onAbort, { once: true });
  });
}

function keepAliveSentinel(): ChildProcess {
  const code =
    'for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {}); setInterval(() => {}, 60000);';
  return spawn(process.execPath, ["-e", code], {
    ...spawnOptions,
    stdio: "ignore",
  });
}

function runAnchor(command: string, args: string[]) {
  return Effect.scoped(
    Effect.gen(function* () {
      const sentinel = keepAliveSentinel();
      yield* Effect.acquireRelease(
        waitForSpawn(sentinel).pipe(Effect.as(sentinel)),
        () =>
          Effect.sync(() => {
            try {
              process.kill(-process.pid, "SIGKILL");
            } catch {
              /* group already exited */
            }
          }),
      );

      const service = spawn(command, args, {
        ...spawnOptions,
        stdio: "inherit",
      });
      const serviceStart = waitForSpawn(service).pipe(
        Effect.catch((error) =>
          send({
            type: "error",
            message: error.message,
            sentinelPid: sentinel.pid,
          }).pipe(
            Effect.andThen(waitForParentDisconnect()),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
      yield* Effect.acquireRelease(
        serviceStart.pipe(Effect.as(service)),
        (child) =>
          Effect.sync(() => {
            if (child.exitCode === null && child.signalCode === null)
              child.kill("SIGKILL");
          }),
      );
      const serviceExit = yield* Effect.forkChild(waitForServiceExit(service));

      yield* send({ type: "ready", sentinelPid: sentinel.pid });
      const adoption = yield* waitForAdoption();
      if (adoption === "disconnected")
        return yield* Effect.fail(
          new Error("Parent disconnected before service adoption"),
        );
      yield* send({ type: "adopted" });

      const exit = yield* Fiber.join(serviceExit);
      return exit.code === 0 ? 0 : 1;
    }),
  ).pipe(
    Effect.catch((error) =>
      send({ type: "error", message: error.message }).pipe(Effect.as(1)),
    ),
  );
}

const parsedArgs = argumentsSchema.safeParse(process.argv.slice(2));
if (!parsedArgs.success) {
  process.stderr.write(
    "Process anchor requires a command and serialized arguments\n",
  );
  process.exitCode = 1;
} else {
  const [command, serialized] = parsedArgs.data;
  let args: string[] | undefined;
  try {
    const parsed: unknown = JSON.parse(serialized);
    const result = serviceArgumentsSchema.safeParse(parsed);
    if (result.success) args = result.data;
  } catch {
    args = undefined;
  }
  if (!args) {
    process.stderr.write("Process anchor received invalid command arguments\n");
    process.exitCode = 1;
  } else {
    void Effect.runPromiseExit(runAnchor(command, args)).then((exit) => {
      process.exitCode = Exit.isSuccess(exit) ? exit.value : 1;
    });
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => {
    // Keep the anchor alive until service exit completes group cleanup.
  });
