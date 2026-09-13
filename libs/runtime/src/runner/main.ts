import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { decodeRunnerCommand } from "@seqlane/protocol";
import {
  requestRunnerCancellation,
  startRun,
  type RunnerHost,
  type RunnerRunControl,
} from "./run.js";
import type { LoadedWorkflow } from "./workflow/load-workflow.js";

export interface RunnerSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Prevent terminal signals from bypassing Seqlane's external-work cleanup. */
export function bindRunnerCancellationSignals(
  source: RunnerSignalSource,
  control: RunnerRunControl,
  onRepeatedSignal?: () => void,
): void {
  const cancel = () => {
    if (control.cancellationRequested) {
      onRepeatedSignal?.();
      return;
    }
    requestRunnerCancellation(control);
  };
  source.on("SIGINT", cancel);
  source.on("SIGTERM", cancel);
}

/** Starts the runtime-owned IPC listener. A non-IPC host is a no-op for library use. */
export function startRunnerProcess(): void {
  if (process.argv[1] !== fileURLToPath(import.meta.url)) return;

  const host = process as unknown as RunnerHost;
  if (typeof host.send !== "function") return;

  let receivedInitialCommand = false;
  const runnerState: { loadedWorkflow?: LoadedWorkflow } = {};
  const control: RunnerRunControl = { cancellationRequested: false };
  bindRunnerCancellationSignals(process, control, () => host.exit(130));

  host.on("message", (message) => {
    if (!receivedInitialCommand) {
      receivedInitialCommand = true;
      try {
        const command = decodeRunnerCommand(message as string);
        if (command.type !== "run.start") {
          throw new TypeError("Expected run.start");
        }
        void startRun(
          host,
          command,
          randomUUID,
          randomUUID,
          (workflow) => {
            runnerState.loadedWorkflow = workflow;
          },
          control,
        ).catch(() => host.exit(1));
      } catch {
        host.exit(1);
      }
      return;
    }

    try {
      const command = decodeRunnerCommand(message as string);
      if (command.type !== "run.cancel") {
        throw new TypeError("Expected run.cancel");
      }
      requestRunnerCancellation(control);
    } catch {
      host.exit(1);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startRunnerProcess();
}
