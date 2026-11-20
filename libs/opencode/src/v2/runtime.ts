import { resolve } from "node:path";
import { z } from "zod";
import { Effect } from "effect";
import type { ModelSelection } from "@seqlane/core";
import {
  redactAgentAdapter,
  redactAgentRuntimeModelCapabilities,
  redactOpaqueValue,
  type AgentAdapter,
  type AgentRuntimeFactory,
} from "@seqlane/agent-adapter";
import { openCodeEffect } from "../effect-boundary.js";
import { createCheckpointRegistry } from "./checkpoint.js";
import { OpenCodeV2Error } from "./errors.js";
import { createClient, verifyServer } from "./client.js";
import { createModelCapabilities } from "./models.js";
import { createSessionAdapter, V2_CAPABILITIES } from "./session.js";

const httpUrl = z.url().pipe(
  z.custom<string>((value) => {
    if (typeof value !== "string") return false;
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "must be an HTTP(S) origin without embedded credentials"),
);
const configurationSchema = z.strictObject({
  adapter: z.literal("opencode-v2"),
  url: httpUrl,
  authorization: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
});

export function createOpenCodeV2AgentRuntimeFactory(
  value: unknown,
): AgentRuntimeFactory {
  const configuration = configurationSchema.parse(value);
  const secrets = [configuration.authorization];
  if (configuration.authorization?.startsWith("Basic ")) {
    const credential = Buffer.from(
      configuration.authorization.slice(6),
      "base64",
    ).toString("utf8");
    secrets.push(credential, credential.slice(credential.indexOf(":") + 1));
  }
  const redact = (text: string): string =>
    secrets.reduce<string>(
      (value, secret) =>
        !secret ? value : value.split(secret).join("[REDACTED]"),
      text,
    );
  return async (signal, selectedWorkspace) => {
    const workspace = resolve(
      selectedWorkspace ?? configuration.workspace ?? process.cwd(),
    );
    const client = createClient(configuration.url, configuration.authorization);
    let closed = false;
    const stopped = new AbortController();
    const checkpoints = createCheckpointRegistry(client, workspace);
    const forks = new Set<Promise<AgentAdapter>>();
    const adapters = new Set<ReturnType<typeof createSessionAdapter>>();
    try {
      await verifyServer(client, signal);
      const models = await createModelCapabilities(client, workspace, signal);
      const forkAdapter = (
        checkpoint: unknown,
        selected: ModelSelection | undefined,
        parentSignal: AbortSignal,
      ): Promise<AgentAdapter> => {
        const pending = Effect.runPromise(
          Effect.gen(function* () {
            if (closed)
              throw new OpenCodeV2Error("execution", "runtime is closed");
            const entry = yield* Effect.try({
              try: () => checkpoints.read(checkpoint),
              catch: (cause) => cause,
            });
            const selection = selected ?? entry.selection;
            yield* openCodeEffect(async () => {
              await models.validateModelSelection?.(selection);
            });
            const lifecycleSignal = AbortSignal.any([
              signal,
              parentSignal,
              stopped.signal,
            ]);
            const initial = yield* checkpoints.fork(
              checkpoint,
              selection,
              lifecycleSignal,
            );
            const adapter = createSessionAdapter({
              client,
              workspace,
              models,
              checkpoints,
              forkAdapter,
              configuredSelection: selection,
              lifecycleSignal,
              redact,
              initialSession: { ...initial, selection },
            });
            adapters.add(adapter);
            return adapter;
          }),
        );
        forks.add(pending);
        void pending
          .finally(() => forks.delete(pending))
          .catch(() => undefined);
        return pending;
      };
      return {
        identity: "opencode-v2",
        capabilities: V2_CAPABILITIES,
        modelCapabilities: redactAgentRuntimeModelCapabilities(models, redact),
        createAdapter(context) {
          if (closed)
            throw new OpenCodeV2Error("execution", "runtime is closed");
          const adapter = createSessionAdapter({
            client,
            checkpoints,
            forkAdapter,
            workspace,
            models,
            configuredSelection: context.modelSelection,
            lifecycleSignal: AbortSignal.any([
              signal,
              context.signal,
              stopped.signal,
            ]),
            redact,
          });
          adapters.add(adapter);
          return adapter;
        },
        redactAdapter: (adapter) => redactAgentAdapter(adapter, redact),
        async close() {
          closed = true;
          stopped.abort();
          await Promise.allSettled([...forks]);
          const results = await Promise.allSettled(
            [...adapters].map((adapter) => adapter.close?.()),
          );
          const roots = await Promise.allSettled([checkpoints.close()]);
          const failures = [...results, ...roots].flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length > 0)
            throw redactOpaqueValue(
              new OpenCodeV2Error(
                "termination",
                "run cleanup failed",
                new AggregateError(failures),
              ),
              redact,
            );
        },
      };
    } catch (cause) {
      throw redactOpaqueValue(cause, redact);
    }
  };
}
