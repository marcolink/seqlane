import {
  encodeSeqlaneExecutionEvent,
  seqlaneExecutionEventSchema,
} from "@seqlane/protocol";
import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import type { ExecutionRenderer, OutputCapabilities } from "@seqlane/output";
import { redactOutput } from "@seqlane/output";
import { connectTerminalResize } from "./output.js";
import { errorMessage, writeDiagnostic } from "./command.js";
import { iterateSeqlaneRecording, type SeqlaneRecording } from "./recording.js";

type RedactionMode =
  | "dynamic"
  | "structural"
  | "event"
  | "metadata"
  | "plan"
  | "subject"
  | "metrics"
  | "model"
  | "summary"
  | "display"
  | "error"
  | "validation"
  | "validationIssue";

const EVENT_STRUCTURAL_KEYS = new Set([
  "type",
  "workId",
  "runId",
  "invocationId",
  "activityId",
  "planNodeId",
  "taskId",
  "parentInvocationId",
  "blockingInvocationId",
  "dependencyIds",
  "policy",
  "channel",
  "state",
  "phase",
  "workspace",
  "kind",
  "disposition",
  "validationNodeId",
  "sourceId",
  "attempt",
  "maximumAttempts",
  "delayMs",
  "nextAttemptAt",
  "iteration",
  "siblingOrder",
  "elapsedMs",
  "activeInvocationIds",
]);

function childMode(
  mode: RedactionMode,
  key: string,
  eventType?: SeqlaneExecutionEvent["type"],
): RedactionMode {
  if (mode === "dynamic") return "dynamic";
  if (mode === "structural") return "structural";
  if (mode === "event") {
    if (EVENT_STRUCTURAL_KEYS.has(key)) {
      return "structural";
    }
    if (key === "metadata") return "metadata";
    if (key === "plan") return "plan";
    if (key === "subject") return "subject";
    if (key === "metrics") return "metrics";
    if (key === "summary") return "summary";
    if (key === "error" || key === "lastError") return "error";
    if (key === "input" || key === "result" || key === "activityMetadata") {
      return "display";
    }
    if (key === "output") {
      return eventType === "run.succeeded" ? "dynamic" : "display";
    }
    return "dynamic";
  }
  if (mode === "metadata" || mode === "subject" || mode === "metrics") {
    return mode === "metrics" && key === "modelSelection"
      ? "model"
      : "structural";
  }
  if (mode === "model") return "structural";
  if (mode === "plan") {
    if (key === "workflow" || key === "nodes" || key === "session") {
      return "plan";
    }
    return key === "label" ? "dynamic" : "structural";
  }
  if (mode === "summary") return key === "fields" ? "dynamic" : "structural";
  if (mode === "display") {
    if (key === "value") return "dynamic";
    if (key === "summary") return "summary";
    return "structural";
  }
  if (mode === "error") {
    return key === "message"
      ? "dynamic"
      : key === "validation"
        ? "validation"
        : "structural";
  }
  if (mode === "validation") {
    if (key === "issues") return "validationIssue";
    if (key === "evidence") return "display";
    return "structural";
  }
  if (mode === "validationIssue") {
    return key === "message" ? "dynamic" : "structural";
  }
  return "structural";
}

function redactReplayValue(
  value: unknown,
  redactions: readonly string[],
  mode: RedactionMode,
  eventType?: SeqlaneExecutionEvent["type"],
): unknown {
  if (typeof value === "string") {
    return mode === "dynamic" ? redactOutput(value, redactions) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      redactReplayValue(item, redactions, mode, eventType),
    );
  }
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      redactReplayValue(
        child,
        redactions,
        childMode(mode, key, eventType),
        eventType,
      ),
    ]),
  );
}

function redactReplayEvent(
  event: SeqlaneExecutionEvent,
  redactions: readonly string[],
): SeqlaneExecutionEvent {
  const redacted = redactReplayValue(event, redactions, "event", event.type);
  return seqlaneExecutionEventSchema.parse(redacted);
}

/** Stream validated recording events as canonical newline-delimited JSON. */
export function writeReplayEvents(
  path: string,
  stdout: { readonly write: (value: string) => void },
  redactions: readonly string[] = [],
): void {
  for (const event of iterateSeqlaneRecording(path)) {
    stdout.write(
      encodeSeqlaneExecutionEvent(redactReplayEvent(event, redactions)) + "\n",
    );
  }
}

/** Render a decoded recording and always release its terminal resize listener. */
export async function renderReplayRecording(options: {
  readonly recording: SeqlaneRecording;
  readonly renderer: ExecutionRenderer;
  readonly capabilities: OutputCapabilities;
  readonly terminal: Pick<
    NodeJS.WriteStream,
    "on" | "removeListener" | "columns"
  >;
}): Promise<void> {
  const { recording, renderer, capabilities, terminal } = options;
  const disconnectResize = connectTerminalResize(renderer, terminal);
  for (const event of recording.events) {
    try {
      renderer.handle(event);
    } catch (error) {
      writeDiagnostic(
        capabilities.stderr,
        "seqlane output error: " + errorMessage(error),
      );
    }
  }
  try {
    await renderer.finish();
  } catch (error) {
    writeDiagnostic(
      capabilities.stderr,
      "seqlane output error: " + errorMessage(error),
    );
  } finally {
    disconnectResize();
  }
}
