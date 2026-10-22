import "./require-shim.js";

import * as core from "@actions/core";
import * as github from "@actions/github";
import { Effect } from "effect";
import { z } from "zod";

const httpErrorSchema = z.object({ status: z.number().int() }).passthrough();
const postCommentSchema = z.object({
  body: z.string().max(65_536).nullable().optional(),
  user: z
    .object({ login: z.string().max(100).nullable().optional() })
    .nullable()
    .optional(),
});
const markerIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .pipe(z.custom<string>((value) => Number.isSafeInteger(Number(value))));
const POST_REQUEST_DEADLINE_MS = 20_000;

interface PostClient {
  readonly rest: {
    readonly issues: {
      getComment(request: {
        readonly owner: string;
        readonly repo: string;
        readonly comment_id: number;
        readonly request?: { readonly signal?: AbortSignal };
      }): Promise<{ readonly data: unknown }>;
      updateComment(request: {
        readonly owner: string;
        readonly repo: string;
        readonly comment_id: number;
        readonly body: string;
        readonly request?: { readonly signal?: AbortSignal };
      }): Promise<unknown>;
    };
  };
}

export interface PostPorts {
  readonly getState: (name: string) => string;
  readonly getInput: (name: string) => string;
  readonly warning: (message: string) => void;
  readonly setFailed: (message: string) => void;
  readonly getOctokit: (token: string) => PostClient;
}

const defaultPostPorts: PostPorts = {
  getState: (name) => core.getState(name),
  getInput: (name) => core.getInput(name),
  warning: (message) => core.warning(message),
  setFailed: (message) => core.setFailed(message),
  getOctokit: (token) => github.getOctokit(token),
};

function cleanupFailureMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Could not remove review marker.";
  const sanitized = message
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .replace(
      /((?:ghp_|gho_|github_pat_|sk-|Bearer\s+)[A-Za-z0-9._-]+)/gi,
      "[REDACTED]",
    )
    .replace(
      /((?:token|api[-_]?key|password|secret)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .trim();
  return `Could not remove review marker: ${(sanitized || "unknown error").slice(0, 500)}`;
}

const io = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.timeoutOption(
    Effect.scoped(
      Effect.gen(function* () {
        const request = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const controller = new AbortController();
            const promise = Promise.resolve().then(() =>
              run(controller.signal),
            );
            return { controller, promise };
          }),
          ({ controller, promise }) =>
            Effect.promise(async () => {
              controller.abort(new Error("GitHub marker cleanup interrupted."));
              await promise.then(
                () => undefined,
                () => undefined,
              );
            }),
        );
        return yield* Effect.tryPromise({
          try: () => request.promise,
          catch: (cause) => cause,
        });
      }),
    ),
    POST_REQUEST_DEADLINE_MS,
  ).pipe(
    Effect.flatMap((result) =>
      result._tag === "None"
        ? Effect.fail(
            new Error(
              "GitHub marker cleanup request exceeded its 20-second deadline.",
            ),
          )
        : Effect.succeed(result.value),
    ),
  );

function httpStatus(error: unknown): number | undefined {
  const parsed = httpErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.status : undefined;
}

export function runPostEffect(
  ports: PostPorts = defaultPostPorts,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const markerId = yield* Effect.sync(() =>
      ports.getState("review-marker-id"),
    );
    if (!markerId) return;
    if (!markerIdSchema.safeParse(markerId).success) {
      yield* Effect.sync(() =>
        ports.warning(
          "The saved review marker ID is invalid; leaving it in place.",
        ),
      );
      return;
    }
    const token = yield* Effect.sync(() => ports.getInput("github-token"));
    if (!token) return;
    const [owner, repo] = yield* Effect.sync(() =>
      ports.getInput("repository").split("/"),
    );
    if (!owner || !repo) return;
    const runId = yield* Effect.sync(() => ports.getState("review-run-id"));
    const client = yield* Effect.sync(() => ports.getOctokit(token));
    const comment = yield* io((signal) =>
      client.rest.issues.getComment({
        owner,
        repo,
        comment_id: Number(markerId),
        request: { signal },
      }),
    ).pipe(
      Effect.map((response) => postCommentSchema.parse(response.data)),
      Effect.catch((error: unknown) => {
        const status = httpStatus(error);
        if (status !== 404) {
          ports.setFailed(cleanupFailureMessage(error));
        }
        return Effect.succeed(undefined);
      }),
    );
    if (comment === undefined) return;
    const body = comment.body ?? "";
    const author = comment.user?.login;
    if (author !== "github-actions" && author !== "github-actions[bot]") {
      yield* Effect.sync(() =>
        ports.warning(
          "The review marker comment is no longer owned by the trusted bot; leaving it in place.",
        ),
      );
      return;
    }
    const marker = `<!-- seqlane-review-in-progress-run: ${runId} -->`;
    if (
      !body.includes("<!-- seqlane-review-in-progress-start -->") ||
      !body.includes(marker)
    )
      return;
    const cleaned = body.replace(
      /<!-- seqlane-review-in-progress-start -->[\s\S]*?<!-- seqlane-review-in-progress-end -->\n?/g,
      "",
    );
    yield* io((signal) =>
      client.rest.issues.updateComment({
        owner,
        repo,
        comment_id: Number(markerId),
        body: cleaned,
        request: { signal },
      }),
    ).pipe(
      Effect.catch((error: unknown) => {
        const status = httpStatus(error);
        return status === 404
          ? Effect.void
          : Effect.sync(() => ports.setFailed(cleanupFailureMessage(error)));
      }),
    );
  });
}

export function runPost(ports: PostPorts = defaultPostPorts): Promise<void> {
  return Effect.runPromise(runPostEffect(ports));
}

if (process.env.NODE_ENV !== "test") {
  const controller = new AbortController();
  const onInt = () =>
    controller.abort(new Error("Action interrupted by SIGINT."));
  const onTerm = () =>
    controller.abort(new Error("Action interrupted by SIGTERM."));
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  Effect.runPromise(Effect.scoped(runPostEffect()), {
    signal: controller.signal,
  })
    .catch((error: unknown) =>
      core.setFailed(
        error instanceof Error ? error.message : "Code review cleanup failed.",
      ),
    )
    .finally(() => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    });
}
