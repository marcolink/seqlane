import { InteractionRequiredError, type ModelSelection } from "@seqlane/core";
import type {
  AgentAdapter,
  AgentAdapterRequest,
  AgentRuntimeModelCapabilities,
} from "@seqlane/agent-adapter";
import type { CheckpointRegistry } from "./checkpoint.js";
import { requestOptions, type V2Client } from "./client.js";
import { admissionSchema, sessionSchema } from "./schemas.js";
import { assertSessionModel, type PinnedNativeModel } from "./session-model.js";
import { nativeModel } from "./models.js";
import { createPrompt } from "./prompt.js";
import { waitForResult } from "./completion.js";
import { OpenCodeV2Error } from "./errors.js";

export const V2_CAPABILITIES = {
  execute: true,
  modelSelection: true,
  structuredOutput: true,
  sessionReuse: true,
  checkpoint: true,
  fork: true,
  activity: true,
  sessionUi: false,
} as const;

interface SessionOptions {
  readonly checkpoints: CheckpointRegistry;
  readonly forkAdapter: (
    checkpoint: unknown,
    selection: ModelSelection | undefined,
    signal: AbortSignal,
  ) => Promise<AgentAdapter>;
  readonly initialSession?: {
    id: string;
    model: PinnedNativeModel;
    selection: ModelSelection;
  };
  readonly client: V2Client;
  readonly workspace: string;
  readonly models: AgentRuntimeModelCapabilities;
  readonly configuredSelection?: ModelSelection;
  readonly lifecycleSignal: AbortSignal;
  readonly redact: (text: string) => string;
}
export function createSessionAdapter({
  client,
  checkpoints,
  forkAdapter,
  initialSession,
  workspace,
  models,
  configuredSelection,
  lifecycleSignal,
  redact,
}: SessionOptions): AgentAdapter {
  let sessionID = initialSession?.id;
  let busy = false;
  let pinnedSelection = initialSession?.selection;
  let pinnedNativeModel = initialSession?.model;
  let latestCheckpoint: unknown;
  let checkpointFailure: unknown;
  let inFlight: Promise<unknown> | undefined;
  const stopped = new AbortController();
  let unusable = false;
  let closing: Promise<void> | undefined;
  async function destroy(): Promise<void> {
    unusable = true;
    if (sessionID === undefined) return;
    const id = sessionID;
    closing ??= checkpoints.remove(id).then(() => {
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
    async captureCheckpoint() {
      if (
        busy ||
        unusable ||
        lifecycleSignal.aborted ||
        latestCheckpoint === undefined
      )
        throw new OpenCodeV2Error(
          "execution",
          "checkpoint is unavailable",
          checkpointFailure,
        );
      return latestCheckpoint;
    },
    fork({ checkpoint, modelSelection }) {
      if (unusable || lifecycleSignal.aborted)
        return Promise.reject(
          new OpenCodeV2Error("execution", "session is unavailable"),
        );
      return forkAdapter(checkpoint, modelSelection, lifecycleSignal);
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
    latestCheckpoint = undefined;
    checkpointFailure = undefined;
    try {
      const prompt = createPrompt(request);
      const selection =
        request.modelSelection ??
        configuredSelection ??
        pinnedSelection ??
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
        const raw = await client.session.create(
          {
            location: { directory: workspace },
            model: nativeModel(selection),
          },
          requestOptions(),
        );
        sessionID = checkpoints.track(raw);
        const session = sessionSchema.parse(raw);
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
      if (current.id !== sessionID || current.location.directory !== workspace)
        throw new OpenCodeV2Error(
          "protocol",
          "native session changed identity or workspace",
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
      const result = await waitForResult(
        client,
        workspace,
        redact,
        request,
        sessionID,
        admitted.id,
        pinnedNativeModel,
      );
      try {
        latestCheckpoint = await checkpoints.capture(
          sessionID,
          selection,
          request.signal,
        );
      } catch (cause) {
        // Snapshot failure cannot change an already successful task result.
        checkpointFailure = cause;
      }
      return result;
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
