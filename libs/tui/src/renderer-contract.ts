import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import { CIRenderer } from "./ci-renderer.js";
import { HumanTTYRenderer } from "./human-renderer.js";

export type RendererMode = "human" | "ci";

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
  readonly height?: number;
  readonly stdout: OutputSink;
  readonly stderr: OutputSink;
  /** Native streams used only by Ink human output. */
  readonly terminal?: {
    readonly stdin: NodeJS.ReadStream;
    readonly stdout: NodeJS.WriteStream;
    readonly stderr: NodeJS.WriteStream;
  };
  readonly summary?: OutputSink;
  /** Secret values that must not appear in rendered output. */
  readonly redactions?: readonly string[];
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

export interface RendererFailure {
  readonly message: string;
}

export interface ExecutionRenderer {
  readonly mode: RendererMode;
  handle(event: SeqlaneExecutionEvent): void;
  handleRunnerFailure?(failure: RendererFailure): void;
  handleRuntimeSessionUi?(notification: RuntimeSessionUi): void;
  finish(): Promise<void>;
}

export type ExecutionRendererFactory = (
  mode: RendererMode,
  capabilities: OutputCapabilities,
) => ExecutionRenderer;

export function createExecutionRenderer(
  mode: RendererMode,
  capabilities: OutputCapabilities,
): ExecutionRenderer {
  if (mode === "human") return new HumanTTYRenderer(capabilities);
  if (mode === "ci") {
    return new CIRenderer(capabilities, {
      redactions: capabilities.redactions,
    });
  }
  throw new Error(`Unsupported renderer mode: ${mode}`);
}
