import type { SeqlaneInvocationMetrics } from "@seqlane/core";
import type { ModelSelection } from "@seqlane/core";
import type { JsonSchema } from "./task.js";
import type {
  StructuredOutputConfiguration,
  ResolvedStructuredOutput,
  StructuredOutputState,
} from "./structured-output-strategy.js";
import type {
  OpenCodeEventObservation,
  OpenCodeTerminalObservation,
} from "./observations.js";

export interface OpenCodeConnection {
  readonly url: string;
  /** Private HTTP authorization for an owned OpenCode service. */
  readonly authorization?: string;
  /** Origin of a detected OpenCode web UI for this runtime. */
  readonly browserUiUrl?: string;
  readonly workspace?: string;
  readonly structuredOutput?: StructuredOutputConfiguration;
  /** Shared by sessions created for one runtime connection. */
  readonly structuredOutputState?: StructuredOutputState;
}

export interface OpenCodePrompt {
  readonly text: string;
  readonly schema: JsonSchema;
  readonly strategy?: "native" | "prompt";
  readonly retryCount?: number;
  readonly tools?: Readonly<Record<string, boolean>>;
  /** Pins the model for this private OpenCode session. */
  readonly selection?: ModelSelection;
  /** OpenCode's native variant field for portable reasoning labels. */
  readonly variant?: string;
  /** Cancels this prompt only after OpenCode acknowledges the session abort. */
  readonly signal?: AbortSignal;
  readonly onActivity?: (activity: OpenCodeActivity) => void;
  /** Receives one validated observation from the single event reducer. */
  readonly onObservation?: (observation: OpenCodeEventObservation) => void;
  /** Reports malformed event observations without changing execution. */
  readonly onDiagnostic?: (message: string) => void;
  /** Reports an external request whose termination cannot be confirmed. */
  readonly onUncertainActivity?: (activity: OpenCodeUncertainActivity) => void;
  /** Invalidates the cached adapter run after an internal abort. */
  readonly onRunInvalidated?: () => void;
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

export interface OpenCodePromptResult {
  readonly structured: unknown;
  readonly text?: string;
  readonly metrics?: SeqlaneInvocationMetrics;
  /** Adapter-private validated terminal observation for reconciliation. */
  readonly observation?: OpenCodeTerminalObservation;
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
  readonly structuredOutput?: () => Promise<ResolvedStructuredOutput>;
  checkpoint(): Promise<OpenCodeSessionCheckpoint>;
  fork(checkpoint: unknown, selection?: ModelSelection): Promise<OpenCodeRun>;
  abort(): Promise<void>;
  close(): Promise<void>;
}
