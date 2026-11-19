import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { encodeSeqlaneExecutionEvent } from "@seqlane/protocol";
import {
  decodeOwnedProcessAcknowledgement,
  encodeOwnedProcessFrame,
  isOwnedProcessAcknowledgementCandidate,
} from "@seqlane/protocol/private/owned-process";
import { captureOwnedProcessIdentity } from "@seqlane/runtime/private/owned-process";

const mode = process.env.RUNNER_SUPERVISION_MODE ?? "ignore-cancel";
const markerPath = process.env.RUNNER_SUPERVISION_MARKER;
let started = false;
let noiseSequence = 0;
const neverExit = (): void => {
  setInterval(() => undefined, 1_000);
};

const sendMessage = (message: string): void => {
  process.send?.(message);
};

async function launchDetachedSentinel(): Promise<number> {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { detached: true, stdio: "ignore" },
  );
  if (child.pid === undefined) throw new Error("Sentinel did not start");
  child.unref();
  return child.pid;
}

async function launchOwnedTree(): Promise<void> {
  const ownedPid = await launchDetachedSentinel();
  const foreignPid = await launchDetachedSentinel();
  if (markerPath === undefined) throw new Error("Missing fixture marker path");
  writeFileSync(markerPath, JSON.stringify({ ownedPid, foreignPid }));
  const identity = await captureOwnedProcessIdentity(ownedPid);
  const id = "supervisor-owned-tree";
  const encoded = encodeOwnedProcessFrame({
    type: "runner.owned-process",
    action: "register",
    id,
    identity,
  });
  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      let candidate: unknown = message;
      if (typeof message === "string") {
        try {
          candidate = JSON.parse(message);
        } catch {
          return;
        }
      }
      if (!isOwnedProcessAcknowledgementCandidate(candidate)) return;
      try {
        const acknowledgement = decodeOwnedProcessAcknowledgement(
          typeof message === "string" ? message : JSON.stringify(message),
        );
        if (
          acknowledgement.action !== "register" ||
          acknowledgement.id !== id ||
          acknowledgement.identity.pid !== identity.pid
        ) {
          reject(new Error("Supervisor acknowledgement did not match"));
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      process.removeListener("message", onMessage);
      resolve();
    };
    process.on("message", onMessage);
    process.send?.(encoded, (error) => {
      if (error !== null && error !== undefined) reject(error);
    });
  });
  if (markerPath !== undefined)
    writeFileSync(`${markerPath}.registered`, "ready");
}

process.on("message", (message: unknown) => {
  if (typeof message !== "string") return;
  if (started) return;
  started = true;
  if (mode === "startup-failure") {
    process.exitCode = 41;
    process.disconnect();
    return;
  }
  if (mode === "disconnect") {
    process.disconnect();
    neverExit();
    return;
  }
  if (mode === "malformed-ipc") {
    sendMessage('{"type":"run.succeeded"}');
    neverExit();
    return;
  }
  if (mode === "sink-failure") {
    sendMessage(
      encodeSeqlaneExecutionEvent({
        type: "run.succeeded",
        workId: "supervisor-test-work",
        runId: "supervisor-test-run",
        output: null,
        metadata: {
          schemaVersion: 1,
          eventId: "supervisor-test-event",
          sequence: 1,
          occurredAt: "2026-10-22T00:00:00.000Z",
        },
      }),
    );
    neverExit();
    return;
  }
  if (mode === "owned-tree") {
    void launchOwnedTree().catch((error: unknown) => {
      process.send?.(`fixture-error:${String(error)}`);
    });
    return;
  }
  if (mode === "noise") {
    setInterval(() => {
      noiseSequence += 1;
      sendMessage(
        encodeSeqlaneExecutionEvent({
          type: "run.started",
          workId: "supervisor-test-work",
          runId: "supervisor-test-run",
          metadata: {
            schemaVersion: 1,
            eventId: `supervisor-noise-${noiseSequence}`,
            sequence: noiseSequence,
            occurredAt: "2026-10-22T00:00:00.000Z",
          },
        }),
      );
    }, 1);
    return;
  }
  if (mode === "terminal-noise") {
    process.on("SIGTERM", () => undefined);
    sendMessage(
      encodeSeqlaneExecutionEvent({
        type: "run.succeeded",
        workId: "supervisor-test-work",
        runId: "supervisor-test-run",
        output: null,
        metadata: {
          schemaVersion: 1,
          eventId: "supervisor-terminal-event",
          sequence: 1,
          occurredAt: "2026-10-22T00:00:00.000Z",
        },
      }),
    );
    setInterval(() => {
      noiseSequence += 1;
      sendMessage(
        encodeSeqlaneExecutionEvent({
          type: "run.started",
          workId: "supervisor-test-work",
          runId: "supervisor-test-run",
          metadata: {
            schemaVersion: 1,
            eventId: `supervisor-terminal-noise-${noiseSequence}`,
            sequence: noiseSequence + 1,
            occurredAt: "2026-10-22T00:00:00.000Z",
          },
        }),
      );
    }, 1);
    return;
  }
  // Deliberately ignore run.start and run.cancel to exercise bounded cleanup.
  neverExit();
});
