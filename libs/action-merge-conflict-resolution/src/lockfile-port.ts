import type { LockfilePort } from "./contracts.js";

export type LockfileRegenerationPort = LockfilePort;

export interface DockerCommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface DockerCommandResult {
  readonly exitCode: number;
  readonly stderr?: string;
}

export interface DockerCommandPort {
  readonly run: (request: DockerCommandRequest) => Promise<DockerCommandResult>;
}
