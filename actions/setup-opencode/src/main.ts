import * as core from "@actions/core";
import { dirname } from "node:path";
import { Effect } from "effect";
import { fetchReleaseMetadata, verifyExecutableVersion } from "./io.js";
import { parseVersion } from "./version.js";
import { resolvePlatform } from "./platform.js";
import { actionsCache } from "./cache.js";
import { actionsToolCache } from "./archive.js";
import { SETUP_DEADLINE_MS, setupOpenCode } from "./setup.js";

function interruptedAction(): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const interrupt = (signal: NodeJS.Signals) =>
    controller.abort(new Error(`GitHub Action interrupted by ${signal}.`));
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    },
  };
}

export async function run(): Promise<void> {
  const { signal, dispose } = interruptedAction();
  const program = Effect.gen(function* () {
    const version = yield* Effect.try({
      try: () => parseVersion(core.getInput("version", { required: true })),
      catch: (cause) => cause,
    });
    const platform = yield* Effect.sync(() => resolvePlatform());
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (token !== undefined && token.length > 0) core.setSecret(token);
    const setup = yield* Effect.timeoutOption(
      setupOpenCode(version, platform, {
        cache: actionsCache,
        toolCache: actionsToolCache,
        getRelease: (requestedVersion, requestSignal) =>
          fetchReleaseMetadata(requestedVersion, token, fetch, requestSignal),
        verifyExecutable: (executable, requestedVersion, requestSignal) =>
          verifyExecutableVersion(
            executable,
            requestedVersion,
            undefined,
            requestSignal,
          ),
        logger: {
          debug: (message) => core.debug(message),
        },
      }),
      SETUP_DEADLINE_MS,
    );
    if (setup._tag === "None") {
      return yield* Effect.fail(
        new Error("OpenCode setup exceeded its 10-minute deadline."),
      );
    }
    const executable = setup.value;
    yield* Effect.sync(() => {
      core.addPath(dirname(executable));
      core.setOutput("executable", executable);
    });
  });
  try {
    await Effect.runPromise(Effect.scoped(program), { signal });
  } finally {
    dispose();
  }
}
