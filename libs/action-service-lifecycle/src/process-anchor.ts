import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcess } from "effect/process";
import { Effect, Exit } from "effect";
import { z } from "zod";

import { anchorAdoptRequestSchema } from "./schemas.js";

const argumentsSchema = z.tuple([z.string().min(1), z.string()]);
const serviceArgumentsSchema = z.array(z.string());
const spawnOptions = {
  cwd: process.cwd(),
  env: process.env,
  detached: false,
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

function runAnchor(command: string, args: string[]) {
  return Effect.scoped(
    Effect.gen(function* () {
      // The anchor owns the detached group. Its scoped children inherit it.
      const sentinel = yield* ChildProcess.make(
        process.execPath,
        [
          "-e",
          'for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {}); setInterval(() => {}, 60000);',
        ],
        {
          ...spawnOptions,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          forceKillAfter: "500 millis",
        },
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(-process.pid, "SIGKILL");
          } catch {
            /* group already exited */
          }
        }),
      );
      const service = yield* ChildProcess.make(command, args, {
        ...spawnOptions,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        forceKillAfter: "500 millis",
      }).pipe(
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

      yield* send({ type: "ready", sentinelPid: sentinel.pid });
      const adoption = yield* waitForAdoption();
      if (adoption === "disconnected")
        return yield* Effect.fail(
          new Error("Parent disconnected before service adoption"),
        );
      yield* send({ type: "adopted" });

      return yield* service.exitCode.pipe(
        Effect.catch(() => Effect.succeed(1)),
      );
    }),
  ).pipe(
    Effect.provide(NodeServices.layer),
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
