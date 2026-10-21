import { once } from "node:events";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RunnerClient } from "../runner-client.js";
import { z } from "zod";

/** Copies the built CLI as an external package and substitutes its runner export. */
export function prepareExternalCli(options: {
  readonly cliRoot: string;
  readonly destination: string;
  readonly runnerEntrypoint: string;
}): string {
  const { cliRoot, destination, runnerEntrypoint } = options;
  mkdirSync(destination, { recursive: true });
  cpSync(join(cliRoot, "bin"), join(destination, "bin"), { recursive: true });
  cpSync(join(cliRoot, "dist"), join(destination, "dist"), {
    recursive: true,
  });
  cpSync(
    join(cliRoot, "oclif.config.mjs"),
    join(destination, "oclif.config.mjs"),
  );
  symlinkSync(join(cliRoot, "node_modules"), join(destination, "node_modules"));

  const packageJson = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")));
  const exports = z
    .record(z.string(), z.record(z.string(), z.string()))
    .parse(packageJson["exports"]);
  exports["./runner"] = {
    types: "./dist/runner.d.ts",
    import: runnerEntrypoint,
    default: runnerEntrypoint,
  };
  packageJson["exports"] = exports;
  writeFileSync(join(destination, "package.json"), JSON.stringify(packageJson));
  return destination;
}

/** Requests bounded cleanup for a supervised test worker. */
export async function closeRunnerWorker(
  client: RunnerClient,
  timeoutMs = 5_000,
): Promise<void> {
  if (client.child.exitCode !== null || client.child.signalCode !== null)
    return;
  const exited = once(client.child, "exit");
  client.close();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Runner worker did not exit")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
