import { randomUUID } from "node:crypto";
import { Cause, Duration, Effect, Exit } from "effect";
import {
  encodeOwnedProcessFrame,
  type OwnedProcessAcknowledgement,
  type OwnedProcessFrame,
  type OwnedProcessIdentity,
} from "@seqlane/protocol/private/owned-process";
import {
  captureOwnedProcessIdentity,
  confirmOwnedProcessGroupStopped,
  confirmOwnedProcessStopped,
  terminateOwnedProcess,
} from "../private/owned-process/index.js";
import { DEFAULT_IPC_ACK_TIMEOUT_MS } from "./ipc-ack.js";

export interface OwnedProcessRegistryHost {
  send(message: string, callback?: (error?: Error | null) => void): boolean;
}

interface PendingAcknowledgement {
  readonly frame: OwnedProcessFrame;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
}

/** Tracks only process identities acknowledged by the supervising CLI. */
export class OwnedProcessRegistry {
  private readonly active = new Map<string, OwnedProcessIdentity>();
  private readonly pending = new Map<string, PendingAcknowledgement>();
  private registrationTail: Promise<void> = Promise.resolve();
  private readonly disconnectController = new AbortController();

  constructor(
    private readonly host: OwnedProcessRegistryHost,
    private readonly timeoutMs = DEFAULT_IPC_ACK_TIMEOUT_MS,
  ) {}

  register(pid: number): Promise<void> {
    const registration = this.registrationTail.then(() =>
      this.registerOwnedProcess(pid),
    );
    this.registrationTail = registration.then(
      () => undefined,
      () => undefined,
    );
    return registration;
  }

  private async registerOwnedProcess(pid: number): Promise<void> {
    let identity: OwnedProcessIdentity;
    try {
      identity = await captureOwnedProcessIdentity(pid);
    } catch (cause) {
      // A short-lived child can exit after acquisition but before this handoff.
      if (!(await confirmOwnedProcessGroupStopped(pid))) throw cause;
      if (this.disconnectController.signal.aborted) {
        throw this.disconnectController.signal.reason;
      }
      return;
    }
    const frame: OwnedProcessFrame = {
      type: "runner.owned-process",
      action: "register",
      id: randomUUID(),
      identity,
    };
    try {
      await this.releaseConfirmedStoppedProcesses();
      await this.sendAndWait(frame);
    } catch (cause) {
      const term = await terminateOwnedProcess(identity, "SIGTERM").catch(
        (cleanupCause) => ({ confirmed: false, cleanupCause }),
      );
      const stopped = term.confirmed
        ? term
        : await terminateOwnedProcess(identity, "SIGKILL").catch(
            (cleanupCause) => ({ confirmed: false, cleanupCause }),
          );
      if (!stopped.confirmed) {
        throw new AggregateError(
          [cause, "cleanupCause" in stopped ? stopped.cleanupCause : undefined],
          "Owned process registration failed and cleanup is uncertain",
        );
      }
      throw cause;
    }
    this.active.set(frame.id, identity);
  }

  async releaseStoppedProcesses(): Promise<void> {
    const exit = await Effect.runPromiseExit(
      Effect.timeout(
        Effect.tryPromise({
          // Cancellation may stop a child while its ownership ACK is pending.
          try: () => this.registrationTail,
          catch: (cause) => cause,
        }).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: async () => {
                for (const [id, identity] of this.active) {
                  if (!(await confirmOwnedProcessStopped(identity))) {
                    throw new Error(`Owned process ${id} has not stopped`);
                  }
                  await this.sendAndWait({
                    type: "runner.owned-process",
                    action: "release",
                    id,
                    identity,
                  });
                  this.active.delete(id);
                }
              },
              catch: (cause) => cause,
            }),
          ),
        ),
        Duration.millis(this.timeoutMs),
      ),
    );
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  }

  supervisorDisconnected(): void {
    if (this.disconnectController.signal.aborted) return;
    this.disconnectController.abort(
      new Error("Runner supervisor disconnected"),
    );
  }

  private async releaseConfirmedStoppedProcesses(): Promise<void> {
    for (const [id, identity] of this.active) {
      if (!(await confirmOwnedProcessStopped(identity))) continue;
      await this.sendAndWait({
        type: "runner.owned-process",
        action: "release",
        id,
        identity,
      });
      this.active.delete(id);
    }
  }

  acceptAcknowledgement(acknowledgement: OwnedProcessAcknowledgement): boolean {
    const pending = this.pending.get(acknowledgement.id);
    if (pending === undefined) return false;
    const expected = pending.frame;
    if (
      acknowledgement.action !== expected.action ||
      acknowledgement.identity.pid !== expected.identity.pid ||
      acknowledgement.identity.processGroupId !==
        expected.identity.processGroupId ||
      acknowledgement.identity.platform !== expected.identity.platform ||
      acknowledgement.identity.birthIdentity !==
        expected.identity.birthIdentity ||
      acknowledgement.identity.version !== expected.identity.version
    ) {
      pending.reject(new Error("Owned process acknowledgement did not match"));
      return true;
    }
    pending.resolve();
    return true;
  }

  private async sendAndWait(frame: OwnedProcessFrame): Promise<void> {
    const encoded = encodeOwnedProcessFrame(frame);
    const control = Effect.callback<void, unknown>((resume) => {
      const signal = this.disconnectController.signal;
      if (signal.aborted) {
        resume(Effect.fail(signal.reason));
        return Effect.void;
      }
      let acknowledged = false;
      let sent = false;
      let settled = false;
      const finish = (effect: Effect.Effect<void, unknown>): void => {
        if (settled) return;
        settled = true;
        resume(effect);
      };
      const finishIfReady = (): void => {
        if (acknowledged && sent) finish(Effect.void);
      };
      this.pending.set(frame.id, {
        frame,
        resolve: () => {
          acknowledged = true;
          finishIfReady();
        },
        reject: (cause) => finish(Effect.fail(cause)),
      });
      try {
        this.host.send(encoded, (error) => {
          if (error != null) finish(Effect.fail(error));
          else {
            sent = true;
            finishIfReady();
          }
        });
      } catch (cause) {
        finish(Effect.fail(cause));
      }
      return Effect.sync(() => this.pending.delete(frame.id));
    });
    const disconnected = Effect.callback<void, unknown>((resume) => {
      const signal = this.disconnectController.signal;
      const onDisconnect = (): void => resume(Effect.fail(signal.reason));
      if (signal.aborted) onDisconnect();
      else signal.addEventListener("abort", onDisconnect, { once: true });
      return Effect.sync(() =>
        signal.removeEventListener("abort", onDisconnect),
      );
    });
    const exit = await Effect.runPromiseExit(
      Effect.timeout(
        Effect.raceFirst(control, disconnected),
        Duration.millis(this.timeoutMs),
      ),
    );
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  }
}
