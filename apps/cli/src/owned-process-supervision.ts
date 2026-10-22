import { Duration, Effect } from "effect";
import {
  encodeOwnedProcessAcknowledgement,
  type OwnedProcessFrame,
  type OwnedProcessIdentity,
} from "@seqlane/protocol/private/owned-process";
import {
  confirmOwnedProcessStopped,
  isOwnedProcessIdentityCurrent,
  terminateOwnedProcess,
} from "@seqlane/runtime/private/owned-process";

export interface OwnedProcessSupervisorHost {
  send(message: string, callback?: (error: Error | null) => void): boolean;
}

export interface OwnedProcessSupervision {
  readonly size: number;
  handle(frame: OwnedProcessFrame): Effect.Effect<void, unknown>;
  cleanup(): Effect.Effect<boolean>;
}

interface OwnedProcessOs {
  readonly isCurrent: (identity: OwnedProcessIdentity) => Promise<boolean>;
  readonly confirmStopped: (identity: OwnedProcessIdentity) => Promise<boolean>;
  readonly terminate: (
    identity: OwnedProcessIdentity,
    signal: "SIGTERM" | "SIGKILL",
  ) => Promise<{ readonly confirmed: boolean }>;
}

const acknowledgementTimeoutMs = 5_000;
const cleanupTimeoutMs = 5_000;
// The shared run budget permits 1,000 repeat attempts. Keep room for bounded
// process-backed startup resources while retaining a finite supervisor map.
const maximumOwnedProcesses = 1_024;
const cleanupConcurrency = 8;

/** Owns ACKed process leases and bounded OS-tree cleanup for one CLI run. */
export function createOwnedProcessSupervision(
  host: OwnedProcessSupervisorHost,
  report: (error: unknown) => void,
  os: OwnedProcessOs = {
    isCurrent: isOwnedProcessIdentityCurrent,
    confirmStopped: confirmOwnedProcessStopped,
    terminate: terminateOwnedProcess,
  },
): OwnedProcessSupervision {
  const processes = new Map<
    string,
    { readonly identity: OwnedProcessIdentity; acknowledged: boolean }
  >();

  const sendAcknowledgement = (
    frame: OwnedProcessFrame,
  ): Effect.Effect<void, unknown> =>
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          host.send(
            encodeOwnedProcessAcknowledgement({
              type: "runner.owned-process.ack",
              action: frame.action,
              id: frame.id,
              identity: frame.identity,
            }),
            (error) => (error === null ? resolve() : reject(error)),
          );
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.timeout(Duration.millis(acknowledgementTimeoutMs)),
      Effect.asVoid,
    );

  const handle = (frame: OwnedProcessFrame): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (frame.action === "register") {
        if (processes.has(frame.id)) {
          return yield* Effect.fail(
            new Error("Owned process identity was registered twice"),
          );
        }
        if (processes.size >= maximumOwnedProcesses) {
          return yield* Effect.fail(
            new Error("Runner exceeded the owned process limit"),
          );
        }
        if (
          !(yield* Effect.tryPromise({
            try: () => os.isCurrent(frame.identity),
            catch: (cause) => cause,
          })) &&
          // Worker identity capture may precede the exit of a short-lived child.
          !(yield* Effect.tryPromise({
            try: () => os.confirmStopped(frame.identity),
            catch: (cause) => cause,
          }))
        ) {
          return yield* Effect.fail(
            new Error("Owned process identity is stale or unverifiable"),
          );
        }
        const lease = { identity: frame.identity, acknowledged: false };
        // Retain the verified lease before ACK so a send failure cannot orphan it.
        processes.set(frame.id, lease);
        yield* sendAcknowledgement(frame);
        lease.acknowledged = true;
        return;
      }

      const registered = processes.get(frame.id);
      if (
        registered === undefined ||
        !registered.acknowledged ||
        registered.identity.version !== frame.identity.version ||
        registered.identity.pid !== frame.identity.pid ||
        registered.identity.processGroupId !== frame.identity.processGroupId ||
        registered.identity.platform !== frame.identity.platform ||
        registered.identity.birthIdentity !== frame.identity.birthIdentity
      ) {
        return yield* Effect.fail(
          new Error("Owned process release did not match its registration"),
        );
      }
      if (
        !(yield* Effect.tryPromise({
          try: () => os.confirmStopped(frame.identity),
          catch: (cause) => cause,
        }))
      ) {
        return yield* Effect.fail(
          new Error("Owned process release preceded confirmed shutdown"),
        );
      }
      processes.delete(frame.id);
      yield* sendAcknowledgement(frame);
    });

  const cleanup = (): Effect.Effect<boolean> =>
    Effect.forEach(
      [...processes.entries()],
      ([id, lease]) =>
        Effect.tryPromise({
          try: () => os.terminate(lease.identity, "SIGKILL"),
          catch: (cause) => cause,
        }).pipe(
          Effect.match({
            onFailure: (error) => {
              report(error);
              return { id, confirmed: false };
            },
            onSuccess: ({ confirmed }) => ({ id, confirmed }),
          }),
        ),
      { concurrency: cleanupConcurrency },
    ).pipe(
      Effect.timeout(Duration.millis(cleanupTimeoutMs)),
      Effect.match({
        onFailure: (error) => {
          report(error);
          return false;
        },
        onSuccess: (results) => {
          let confirmed = true;
          for (const result of results) {
            if (result.confirmed) processes.delete(result.id);
            else {
              confirmed = false;
              report(
                new Error(
                  `Could not confirm owned process ${result.id} stopped`,
                ),
              );
            }
          }
          return confirmed;
        },
      }),
    );

  return {
    get size() {
      return processes.size;
    },
    handle,
    cleanup,
  };
}
