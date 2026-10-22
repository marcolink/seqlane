import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, Option } from "effect";
import { z } from "zod";

import { ActionResolutionError } from "./errors.js";
import {
  dockerCliEffect,
  dockerIo,
  type DockerOwnershipState,
} from "./docker-cli.js";
import type {
  DockerCommandPort,
  DockerCommandRequest,
  DockerCommandResult,
} from "./lockfile-port.js";

const ownerLabel = "io.seqlane.generated-workspace-owner";
const containerIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const inspectSchema = z.tuple([
  z.object({
    Id: containerIdSchema,
    Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
    State: z.object({ Running: z.boolean(), ExitCode: z.number().int() }),
  }),
]);

export class DockerCleanupUnconfirmedError extends ActionResolutionError {
  constructor(cause: unknown) {
    super(
      "lockfile",
      "LOCKFILE_REGENERATION_FAILED",
      "Docker cleanup is unconfirmed; its temporary workspace was retained.",
      cause,
    );
    this.name = "DockerCleanupUnconfirmedError";
  }
}

interface OwnedContainer {
  readonly name: string;
  readonly token: string;
  createAttempted: boolean;
  id?: string;
}

function command(
  request: DockerCommandRequest,
  args: readonly string[],
  state: DockerOwnershipState,
) {
  return dockerCliEffect(
    { ...request, args, signal: undefined, timeoutMs: 5_000 },
    state,
  );
}

function inspectContainer(
  request: DockerCommandRequest,
  id: string,
  state: DockerOwnershipState,
) {
  return Effect.gen(function* () {
    const result = yield* command(request, ["container", "inspect", id], state);
    if (result.exitCode !== 0) return yield* Effect.fail(result);
    const document: unknown = yield* Effect.try((): unknown =>
      JSON.parse(result.stdout),
    );
    return yield* Effect.try(() => inspectSchema.parse(document)[0]);
  });
}

function listedIds(
  request: DockerCommandRequest,
  filter: string,
  state: DockerOwnershipState,
) {
  return Effect.gen(function* () {
    const result = yield* command(
      request,
      ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", filter],
      state,
    );
    if (result.exitCode !== 0) return yield* Effect.fail(result);
    return yield* Effect.try(() =>
      z
        .array(containerIdSchema)
        .parse(
          result.stdout.trim() === "" ? [] : result.stdout.trim().split(/\s+/),
        ),
    );
  });
}

function releaseContainer(
  owned: OwnedContainer,
  request: DockerCommandRequest,
  state: DockerOwnershipState,
) {
  return Effect.gen(function* () {
    if (!owned.createAttempted) return;
    if (state.uncertainty !== undefined)
      return yield* Effect.fail(state.uncertainty.cause);
    const candidates = yield* listedIds(
      request,
      owned.id === undefined ? `name=^/${owned.name}$` : `id=${owned.id}`,
      state,
    );
    if (candidates.length === 0) {
      if (owned.id !== undefined) return;
      return yield* Effect.fail(
        new Error(
          "Docker create was not acknowledged; the daemon may still complete it.",
          {
            cause: {
              containerName: owned.name,
              ownerLabel,
              ownerToken: owned.token,
            },
          },
        ),
      );
    }
    const candidate = candidates[0];
    if (candidates.length !== 1 || candidate === undefined)
      return yield* Effect.fail(
        new Error("Docker container identity is ambiguous."),
      );
    const container = yield* inspectContainer(request, candidate, state);
    if (container.Id !== candidates[0]) {
      return yield* Effect.fail(
        new Error("Docker container readback ID changed."),
      );
    }
    if (container.Config.Labels?.[ownerLabel] !== owned.token) {
      // A name collision never grants ownership of a foreign container.
      if (owned.id === undefined) return;
      return yield* Effect.fail(
        new Error("Docker container ownership changed."),
      );
    }
    if (owned.id !== undefined && container.Id !== owned.id) {
      return yield* Effect.fail(new Error("Docker container ID changed."));
    }
    yield* command(
      request,
      ["container", "rm", "--force", container.Id],
      state,
    );
    const remaining = yield* listedIds(request, `id=${container.Id}`, state);
    if (remaining.length !== 0)
      return yield* Effect.fail(
        new Error("Docker container removal is unconfirmed."),
      );
  });
}

/** Native composition used by both production Docker consumers. */
export function dockerCommandEffect(
  request: DockerCommandRequest,
  state: DockerOwnershipState,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        restore(
          Effect.scoped(
            Effect.gen(function* () {
              const owned = yield* Effect.acquireRelease(
                Effect.sync((): OwnedContainer => ({
                  name: `seqlane-generated-${randomUUID()}`,
                  token: randomUUID(),
                  createAttempted: false,
                })),
                (container) =>
                  releaseContainer(container, request, state).pipe(
                    Effect.catch((cause) =>
                      Effect.sync(() => {
                        state.uncertainty = { cause };
                      }),
                    ),
                  ),
              );
              const body = Effect.gen(function* () {
                owned.createAttempted = true;
                const created = yield* dockerCliEffect(
                  {
                    ...request,
                    args: [
                      "container",
                      "create",
                      "--name",
                      owned.name,
                      "--label",
                      `${ownerLabel}=${owned.token}`,
                      ...request.args.slice(request.args[1] === "--rm" ? 2 : 1),
                    ],
                  },
                  state,
                );
                if (created.exitCode !== 0) return created;
                owned.id = yield* Effect.try(() =>
                  containerIdSchema.parse(created.stdout.trim()),
                );
                const identity = yield* inspectContainer(
                  request,
                  owned.id,
                  state,
                );
                if (
                  identity.Id !== owned.id ||
                  identity.Config.Labels?.[ownerLabel] !== owned.token
                ) {
                  return yield* Effect.fail(
                    new Error(
                      "Docker did not confirm the created container identity.",
                    ),
                  );
                }
                const started = yield* dockerCliEffect(
                  {
                    ...request,
                    args: ["container", "start", "--attach", owned.id],
                  },
                  state,
                );
                const result = yield* inspectContainer(
                  request,
                  owned.id,
                  state,
                );
                if (result.State.Running)
                  return yield* Effect.fail(
                    new Error(
                      "Docker client exited while the container remained active.",
                    ),
                  );
                return {
                  exitCode:
                    started.exitCode === 0
                      ? result.State.ExitCode
                      : started.exitCode,
                  stderr: started.stderr,
                };
              });
              return yield* body.pipe(
                Effect.timeout(request.timeoutMs ?? 300_000),
              );
            }),
          ),
        ),
      );
      if (state.uncertainty !== undefined) {
        if (Exit.isFailure(exit)) {
          const primary = Cause.findErrorOption(exit.cause);
          const operationCause = Option.isSome(primary)
            ? primary.value
            : Cause.squash(exit.cause);
          state.uncertainty = {
            cause: new AggregateError(
              [operationCause, state.uncertainty.cause],
              "Docker operation and cleanup both failed.",
              { cause: operationCause },
            ),
          };
        }
        return yield* Effect.fail(
          new DockerCleanupUnconfirmedError(state.uncertainty.cause),
        );
      }
      return yield* exit;
    }),
  );
}

export function dockerPortEffect(
  request: DockerCommandRequest,
  port: DockerCommandPort | undefined,
  state: DockerOwnershipState,
) {
  if (port === undefined) return dockerCommandEffect(request, state);
  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const controller = new AbortController();
          const settled = { done: false };
          const result = Promise.resolve()
            .then(() => port.run({ ...request, signal: controller.signal }))
            .finally(() => {
              settled.done = true;
            });
          void result.catch(() => undefined);
          return { controller, result, settled };
        }),
        ({ controller, result, settled }) => {
          controller.abort();
          return dockerIo(() => result).pipe(
            Effect.timeout("5 seconds"),
            Effect.catch((cause) =>
              Effect.sync(() => {
                if (
                  !settled.done ||
                  cause instanceof DockerCleanupUnconfirmedError
                )
                  state.uncertainty = { cause };
              }),
            ),
            Effect.asVoid,
          );
        },
      );
      return yield* dockerIo(() => pending.result);
    }),
  ).pipe(
    Effect.catch((cause) => {
      if (cause instanceof DockerCleanupUnconfirmedError)
        state.uncertainty = { cause };
      return Effect.fail(cause);
    }),
  );
}

export async function runDockerOperation<A>(
  operation: Effect.Effect<A, unknown>,
  state: DockerOwnershipState,
  options: Pick<DockerCommandRequest, "signal" | "onUncertain">,
): Promise<A> {
  const exit = await Effect.runPromiseExit(operation, {
    signal: options.signal,
  });
  if (state.uncertainty !== undefined) {
    options.onUncertain?.(state.uncertainty.cause);
    throw new DockerCleanupUnconfirmedError(state.uncertainty.cause);
  }
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw Cause.squash(exit.cause);
}

export function runDockerCommand(
  request: DockerCommandRequest,
): Promise<DockerCommandResult> {
  const state: DockerOwnershipState = {};
  return runDockerOperation(
    dockerCommandEffect(request, state),
    state,
    request,
  );
}
