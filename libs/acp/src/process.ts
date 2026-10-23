import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { Effect, Scope, Stream } from "effect";
import {
  captureOwnedProcessIdentity,
  confirmOwnedProcessGroupStopped,
  observeChildLifecycle,
  terminateOwnedProcess,
  type OwnedProcessIdentity,
} from "@seqlane/agent-adapter/private/owned-process";
import type { AcpLaunchConfiguration } from "./contracts.js";
import { AcpAdapterError } from "./errors.js";

function windowsTreeHasLiveProcesses(rootPid: number): boolean {
  const script = [
    "$root = [int]$args[0]",
    "$all = @(Get-CimInstance Win32_Process)",
    "$ids = [System.Collections.Generic.HashSet[int]]::new()",
    "$null = $ids.Add($root)",
    "do { $before = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { $null = $ids.Add([int]$p.ProcessId) } } } while ($ids.Count -gt $before)",
    "$ids | ForEach-Object { if ($all.ProcessId -contains $_) { $_ } }",
  ].join("; ");
  return (
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script, String(rootPid)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
    ).trim().length > 0
  );
}

function terminateWindowsChild(
  child: ChildProcessWithoutNullStreams,
  lifecycle: ReturnType<typeof observeChildLifecycle>,
) {
  return Effect.gen(function* () {
    const pid = child.pid;
    if (pid === undefined) return;
    const failures: unknown[] = [];
    if (child.exitCode === null && child.signalCode === null) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 5_000,
        });
      } catch (cause) {
        failures.push(cause);
      }
    }
    const gone = yield* Effect.whileLoop({
      while: () => windowsTreeHasLiveProcesses(pid),
      body: () => Effect.sleep("25 millis"),
      step: () => undefined,
    }).pipe(Effect.timeoutOption("5 seconds"));
    if (gone._tag === "Some") {
      const exited = yield* lifecycle.exit.pipe(
        Effect.timeoutOption("5 seconds"),
      );
      if (exited._tag === "Some") return;
    }
    return yield* Effect.fail(
      new AcpAdapterError(
        "cancellation",
        "Windows ACP process-tree termination was not confirmed",
        new AggregateError(failures),
      ),
    );
  });
}

function terminateChild(
  child: ChildProcessWithoutNullStreams,
  identity: OwnedProcessIdentity | undefined,
  lifecycle: ReturnType<typeof observeChildLifecycle>,
) {
  return Effect.gen(function* () {
    if (child.pid === undefined) return;
    child.stdin.destroy();
    if (process.platform === "win32")
      return yield* terminateWindowsChild(child, lifecycle);
    if (
      yield* Effect.tryPromise(() =>
        confirmOwnedProcessGroupStopped(child.pid ?? 0),
      )
    )
      return;
    if (identity === undefined) {
      if (yield* lifecycle.isRunning) {
        child.kill("SIGTERM");
        const graceful = yield* lifecycle.exit.pipe(
          Effect.timeoutOption("1 second"),
        );
        if (graceful._tag === "None") {
          child.kill("SIGKILL");
          yield* lifecycle.exit.pipe(Effect.timeout("5 seconds"));
        }
      }
      if (
        yield* Effect.tryPromise(() =>
          confirmOwnedProcessGroupStopped(child.pid ?? 0),
        )
      )
        return;
      return yield* Effect.fail(
        new AcpAdapterError(
          "cancellation",
          "ACP process identity is unavailable; termination is unconfirmed",
        ),
      );
    }
    const graceful = yield* Effect.tryPromise(() =>
      terminateOwnedProcess(identity, "SIGTERM"),
    );
    if (
      !graceful.confirmed &&
      !(yield* Effect.tryPromise(() =>
        terminateOwnedProcess(identity, "SIGKILL"),
      )).confirmed
    )
      return yield* Effect.fail(
        new AcpAdapterError(
          "cancellation",
          "ACP process-tree termination was not confirmed",
        ),
      );
  });
}

/** Preserve identity-aware signaling while Effect owns scope, streams and waits. */
export function acquireAcpProcess(
  configuration: AcpLaunchConfiguration,
  scope: Scope.Scope,
) {
  let identity: OwnedProcessIdentity | undefined;
  return Effect.gen(function* () {
    const acquired = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const handle = spawn(configuration.command, configuration.args ?? [], {
          cwd: configuration.cwd,
          env: { ...process.env, ...configuration.env },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        return { handle, lifecycle: observeChildLifecycle(handle) };
      }),
      ({ handle, lifecycle }) =>
        terminateChild(handle, identity, lifecycle).pipe(Effect.orDie),
    );
    const { handle, lifecycle } = acquired;
    yield* Effect.uninterruptible(
      lifecycle.spawned.pipe(Effect.timeout("5 seconds")),
    );
    identity = yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: async () => {
          try {
            return await captureOwnedProcessIdentity(handle.pid ?? 0);
          } catch (cause) {
            if (await confirmOwnedProcessGroupStopped(handle.pid ?? 0))
              return undefined;
            throw cause;
          }
        },
        catch: (cause) => cause,
      }),
    );
    yield* Effect.forkIn(
      Stream.runDrain(
        NodeStream.fromReadable({
          evaluate: () => handle.stderr,
          onError: (cause) => cause,
        }),
      ),
      scope,
    );
    return { handle, lifecycle };
  }).pipe(Effect.provideService(Scope.Scope, scope));
}
