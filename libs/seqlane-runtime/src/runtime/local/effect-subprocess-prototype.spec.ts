// @test-scope ./effect-subprocess-prototype.ts
import * as NodeContext from "@effect/platform-node/NodeContext";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  EffectSubprocessInterruptedError,
  EffectSubprocessOutputLimitError,
  EffectSubprocessSpawnError,
  effectSubprocessPrototype,
  runEffectSubprocessPrototype,
} from "./effect-subprocess-prototype.js";

const workspace = process.cwd();

async function failureOf(
  request: Parameters<typeof effectSubprocessPrototype>[0],
) {
  const exit = await Effect.runPromiseExit(
    Effect.provide(effectSubprocessPrototype(request), NodeContext.layer),
  );
  if (!Exit.isFailure(exit))
    throw new Error("Expected the Effect subprocess to fail");
  return Option.getOrThrow(Cause.failureOption(exit.cause));
}

function nodeScript(
  source: string,
  options: { readonly signal?: AbortSignal } = {},
) {
  return runEffectSubprocessPrototype({
    command: process.execPath,
    args: ["-e", source],
    cwd: workspace,
    outputLimitBytes: 1024,
    ...options,
  });
}

describe("Effect v3 subprocess prototype", () => {
  it("runs direct argv in the requested cwd with separate bounded output", async () => {
    const literalArgument = "$(not-a-shell); literal argument";
    const result = await runEffectSubprocessPrototype({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(`${process.cwd()}\\n${process.argv[1]}`); process.stderr.write('stderr')",
        literalArgument,
      ],
      cwd: workspace,
      outputLimitBytes: 1024,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${workspace}\n${literalArgument}`,
      stderr: "stderr",
    });
  });

  it("returns the exit code only after both output streams close", async () => {
    const result = await nodeScript(
      "process.stdout.write('out'); process.stderr.write('err'); setTimeout(() => process.exit(23), 20)",
    );

    expect(result).toEqual({ exitCode: 23, stdout: "out", stderr: "err" });
  });

  it("bounds stdout and stderr independently with typed stream errors", async () => {
    await expect(
      failureOf({
        command: process.execPath,
        args: ["-e", "process.stdout.write('too much output')"],
        cwd: workspace,
        outputLimitBytes: 3,
      }),
    ).resolves.toBeInstanceOf(EffectSubprocessOutputLimitError);

    await expect(
      failureOf({
        command: process.execPath,
        args: ["-e", "process.stderr.write('too much output')"],
        cwd: workspace,
        outputLimitBytes: 3,
      }),
    ).resolves.toBeInstanceOf(EffectSubprocessOutputLimitError);
  });

  it("maps spawn failures to a typed error", async () => {
    await expect(
      failureOf({
        command: "seqlane-command-that-does-not-exist",
        args: [],
        cwd: workspace,
        outputLimitBytes: 1024,
      }),
    ).resolves.toBeInstanceOf(EffectSubprocessSpawnError);
  });

  it("terminates an aborted child before the scoped prototype completes", async () => {
    const controller = new AbortController();
    let pid: number | undefined;
    const running = failureOf({
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1_000)"],
      cwd: workspace,
      outputLimitBytes: 1024,
      signal: controller.signal,
      onStarted: (startedPid) => {
        pid = startedPid;
      },
    });

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (pid !== undefined) {
          clearInterval(timer);
          resolve();
        }
      }, 1);
      void timer;
    });
    controller.abort();
    await expect(running).resolves.toBeInstanceOf(
      EffectSubprocessInterruptedError,
    );

    expect(() => process.kill(pid!, 0)).toThrow();
  });
});
