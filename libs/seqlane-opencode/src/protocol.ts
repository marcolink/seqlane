import type { SeqlaneInvocationMetrics } from "@seqlane/core";
import type { JsonSchema } from "./task.js";

export interface OpenCodeConnection {
  readonly url: string;
  /** Origin of a detected OpenCode web UI for this runtime. */
  readonly browserUiUrl?: string;
  readonly workspace?: string;
}

export interface OpenCodePrompt {
  readonly text: string;
  readonly schema: JsonSchema;
  /** Cancels this prompt only after OpenCode acknowledges the session abort. */
  readonly signal?: AbortSignal;
  readonly onActivity?: (activity: OpenCodeActivity) => void;
  /** Reports an external request whose termination cannot be confirmed. */
  readonly onUncertainActivity?: (activity: OpenCodeUncertainActivity) => void;
  readonly onBackgroundProcess?: (process: OpenCodeBackgroundProcess) => void;
}

export interface OpenCodeUncertainActivity {
  readonly reason: "timeout" | "disconnect";
  readonly termination?: Promise<unknown>;
}

export type OpenCodeActivityKind = "tool" | "skill";

export interface OpenCodeActivity {
  readonly activityId: string;
  readonly kind: OpenCodeActivityKind;
  readonly name: string;
  readonly state: "started" | "progress" | "succeeded" | "failed";
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: unknown;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly message?: string;
}

export interface OpenCodeBackgroundProcess {
  readonly mutatesWorkspace: true;
}

export interface OpenCodePromptResult {
  readonly structured: unknown;
  readonly metrics?: SeqlaneInvocationMetrics;
}

export interface OpenCodeSessionCheckpoint {
  readonly sessionId: string;
  readonly messageId: string;
}

export interface OpenCodeRun {
  /** Present when the configured runtime provides an OpenCode web UI. */
  readonly browserUrl?: string;
  readonly workspace?: string;
  prompt(request: OpenCodePrompt): Promise<OpenCodePromptResult>;
  checkpoint(): Promise<OpenCodeSessionCheckpoint>;
  fork(checkpoint: unknown): Promise<OpenCodeRun>;
  abort(): Promise<void>;
}
