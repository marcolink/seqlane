import type { SeqlaneExecutionEvent } from "@seqlane/events";
import { CIRenderer } from "./ci-renderer.js";
import { HumanTTYRenderer } from "./human-renderer.js";
import { JSONRenderer } from "./json-renderer.js";

export type RendererMode = "human" | "ci" | "json";

export type OutputMode = RendererMode | "auto";

export interface OutputSink {
  write(value: string): void;
  flush?(): Promise<void>;
}

export interface OutputCapabilities {
  readonly isTTY: boolean;
  readonly supportsAnsi: boolean;
  readonly supportsUnicode: boolean;
  readonly width: number;
  readonly stdout: OutputSink;
  readonly stderr: OutputSink;
  readonly summary?: OutputSink;
  /** Explicitly enabled sink for GitHub Actions workflow commands. */
  readonly githubActions?: {
    readonly annotations: OutputSink;
  };
}

/** Non-canonical presentational data supplied by a runtime adapter. */
export interface RuntimeSessionUi {
  readonly invocationId: string;
  readonly browserUrl: string;
}

export interface ExecutionRenderer {
  readonly mode: RendererMode;
  handle(event: SeqlaneExecutionEvent): void;
  handleRuntimeSessionUi?(notification: RuntimeSessionUi): void;
  finish(): Promise<void>;
}

export type ExecutionRendererFactory = (
  mode: RendererMode,
  capabilities: OutputCapabilities,
) => ExecutionRenderer;

export function createNoopRenderer(mode: RendererMode): ExecutionRenderer {
  return {
    mode,
    handle: () => undefined,
    finish: async () => undefined,
  };
}

export function createExecutionRenderer(
  mode: RendererMode,
  capabilities: OutputCapabilities,
): ExecutionRenderer {
  if (mode === "human") return new HumanTTYRenderer(capabilities);
  if (mode === "ci") return new CIRenderer(capabilities);
  return new JSONRenderer(capabilities);
}
