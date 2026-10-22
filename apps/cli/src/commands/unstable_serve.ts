import { Command, Flags } from "@oclif/core";
import type { PrivateClassifierConnection } from "@seqlane/runtime/runner";
import { captureTelemetryConfigurationEnvironment } from "@seqlane/runtime/private/telemetry";
import { Cause, Effect, Exit } from "effect";
import {
  agentRuntimeConfigurationEnvironment,
  loadAgentRuntimeFactory,
} from "../agent-runtime.js";
import { captureClassifierConnectionEnvironment } from "../classifier-environment.js";
import { createOwnedOperationalHost } from "../operational-command-host.js";
import { workflowRootsFromFlags } from "../workflow-roots.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ServeSignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

interface OperationalServeHost {
  listen(): Promise<string>;
  close(): Promise<void>;
}

export function operationalServeLifetime(
  startHost: () => Promise<OperationalServeHost>,
  log: (message: string) => void,
  signalSource: ServeSignalSource = process,
): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      let stopRequested = false;
      let resumeStop: (() => void) | undefined;
      const onSignal = (): void => {
        stopRequested = true;
        resumeStop?.();
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          signalSource.once("SIGINT", onSignal);
          signalSource.once("SIGTERM", onSignal);
        }),
        () =>
          Effect.sync(() => {
            signalSource.removeListener("SIGINT", onSignal);
            signalSource.removeListener("SIGTERM", onSignal);
          }),
      );
      const operationalHost = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: startHost,
          catch: (cause) => cause,
        }),
        (host) => Effect.promise(() => host.close()),
      );
      if (stopRequested) return;
      const address = yield* Effect.tryPromise({
        try: () => operationalHost.listen(),
        catch: (cause) => cause,
      });
      log(`Seqlane operational host: ${address}`);
      log(`Seqlane readiness: ${address}/readyz`);
      if (!stopRequested) {
        yield* Effect.callback<void>((resume) => {
          if (stopRequested) {
            resume(Effect.void);
            return;
          }
          resumeStop = () => resume(Effect.void);
          return Effect.sync(() => {
            resumeStop = undefined;
          });
        });
      }
    }),
  );
}

export default class ServeCommand extends Command {
  static override hidden = true;

  static override description =
    "Run the foreground Seqlane operational host for discovered workflows";

  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --port 4112 --storage-url file:./.seqlane/operations.db",
  ];

  static override flags = {
    hostname: Flags.string({
      description: "Loopback hostname for the operational host",
      default: "127.0.0.1",
    }),
    port: Flags.integer({
      description: "Loopback port for the operational host",
      default: 4111,
    }),
    "storage-url": Flags.string({
      description: "Operational SQL storage URL",
      default: "file:./.seqlane/operations.db",
    }),
    "repository-root": Flags.string({
      description: "Repository workflow descriptor root",
    }),
    "user-root": Flags.string({
      description: "User workflow descriptor root",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ServeCommand);
    try {
      // Capture private settings before importing authored workflow modules.
      const classifierConnection: PrivateClassifierConnection | undefined =
        captureClassifierConnectionEnvironment(process.env);
      const telemetryConfiguration = captureTelemetryConfigurationEnvironment(
        process.env,
      );
      const roots = workflowRootsFromFlags(flags);
      const agentRuntime =
        process.env[agentRuntimeConfigurationEnvironment] === undefined
          ? undefined
          : loadAgentRuntimeFactory();
      const program = operationalServeLifetime(
        () =>
          createOwnedOperationalHost({
            roots,
            host: flags.hostname,
            port: flags.port,
            storageUrl: flags["storage-url"],
            agentRuntime,
            classifierConnection,
            telemetryConfiguration,
          }),
        this.log.bind(this),
      );
      const exit = await Effect.runPromiseExit(program);
      if (Exit.isFailure(exit)) {
        this.error(
          `Seqlane operational host failed: ${errorMessage(Cause.squash(exit.cause))}`,
        );
      }
    } catch (error) {
      this.error(`Seqlane operational host failed: ${errorMessage(error)}`);
    }
  }
}
