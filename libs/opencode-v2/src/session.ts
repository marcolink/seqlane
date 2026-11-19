import { InteractionRequiredError, type ModelSelection } from "@seqlane/core";
import type {
  AgentAdapter,
  AgentAdapterRequest,
  AgentRuntimeModelCapabilities,
} from "@seqlane/agent-adapter";
import { requestOptions, type V2Client } from "./client.js";
import { admissionSchema, sessionSchema } from "./schemas.js";
import { assertSessionModel, type PinnedNativeModel } from "./session-model.js";
import { nativeModel } from "./models.js";
import { createPrompt } from "./prompt.js";
import { terminateOwnedSession } from "./owned-work.js";
import { waitForResult } from "./completion.js";
import { OpenCodeV2Error } from "./errors.js";

export const V2_CAPABILITIES = {
  execute: true,
  modelSelection: true,
  structuredOutput: true,
  sessionReuse: true,
  checkpoint: false,
  fork: false,
  activity: true,
  sessionUi: false,
} as const;

interface SessionOptions {
  readonly client: V2Client;
  readonly workspace: string;
  readonly models: AgentRuntimeModelCapabilities;
  readonly configuredSelection?: ModelSelection;
  readonly lifecycleSignal: AbortSignal;
  readonly redact: (text: string) => string;
}
export function createSessionAdapter({
  client,
  workspace,
  models,
  configuredSelection,
  lifecycleSignal,
  redact,
}: SessionOptions): AgentAdapter {
  let sessionID: string | undefined;
  let busy = false;
  let pinnedSelection: ModelSelection | undefined;
  let pinnedNativeModel: PinnedNativeModel | undefined;
  let inFlight: Promise<unknown> | undefined;
  const stopped = new AbortController();
  let unusable = false;
  let closing: Promise<void> | undefined;
  async function destroy(): Promise<void> {
    unusable = true;
    if (sessionID === undefined) return;
    const id = sessionID;
    closing ??= terminateOwnedSession(client, id, workspace).then(() => {
      sessionID = undefined;
    });
    return closing;
  }

  return {
    capabilities: V2_CAPABILITIES,
    execute(original) {
      if (busy || unusable)
        return Promise.reject(
          new OpenCodeV2Error("execution", "session is busy or unavailable"),
        );
      const signal = AbortSignal.any([
        original.signal,
        stopped.signal,
        lifecycleSignal,
      ]);
      const request = { ...original, signal };
      inFlight = execute(request).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    async close() {
      unusable = true;
      stopped.abort();
      await inFlight?.catch(() => undefined);
      await destroy();
    },
  };
  async function execute(request: AgentAdapterRequest): Promise<unknown> {
    if (busy || unusable)
      throw new OpenCodeV2Error("execution", "session is busy or unavailable");
    busy = true;
    try {
      const prompt = createPrompt(request);
      const selection =
        request.modelSelection ??
        configuredSelection ??
        (await models.resolveDefaultModel());
      await models.validateModelSelection?.(selection);
      if (
        pinnedSelection !== undefined &&
        JSON.stringify(nativeModel(pinnedSelection)) !==
          JSON.stringify(nativeModel(selection))
      )
        throw new OpenCodeV2Error(
          "configuration",
          "reuse cannot change the session model",
        );
      request.signal.throwIfAborted();
      if (sessionID === undefined) {
        const session = sessionSchema.parse(
          await client.session.create(
            {
              location: { directory: workspace },
              model: nativeModel(selection),
            },
            requestOptions(request.signal),
          ),
        );
        sessionID = session.id;
        pinnedSelection = selection;
        pinnedNativeModel = assertSessionModel(session, selection);
        if (session.location.directory !== workspace)
          throw new OpenCodeV2Error(
            "protocol",
            "created session has a different workspace",
          );
      }
      const current = sessionSchema.parse(
        await client.session.get({ sessionID }, requestOptions(request.signal)),
      );
      const currentModel = assertSessionModel(current, selection);
      if (pinnedNativeModel === undefined)
        throw new OpenCodeV2Error("protocol", "session model was not pinned");
      if (currentModel.variant !== pinnedNativeModel.variant)
        throw new OpenCodeV2Error(
          "protocol",
          "native session changed the selected model",
        );
      request.signal.throwIfAborted();
      request.onExecutionStarted();
      const admitted = admissionSchema.parse(
        await client.session.prompt(
          { sessionID, text: prompt },
          requestOptions(request.signal),
        ),
      );
      if (admitted.sessionID !== sessionID)
        throw new OpenCodeV2Error(
          "protocol",
          "input was admitted to a different session",
        );
      return await waitForResult(
        client,
        workspace,
        redact,
        request,
        sessionID,
        admitted.id,
        pinnedNativeModel,
      );
    } catch (cause) {
      try {
        await destroy();
      } catch (cleanup) {
        request.onUncertainActivity?.({
          reason: request.signal.aborted ? "timeout" : "disconnect",
        });
        throw new OpenCodeV2Error(
          "termination",
          "owned work termination is unconfirmed",
          new AggregateError([cause, cleanup]),
        );
      }
      if (
        cause instanceof OpenCodeV2Error ||
        cause instanceof InteractionRequiredError ||
        request.signal.aborted
      )
        throw cause;
      throw new OpenCodeV2Error("execution", "native invocation failed", cause);
    } finally {
      busy = false;
    }
  }
}
