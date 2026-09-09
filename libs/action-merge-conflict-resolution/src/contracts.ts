import { z } from "zod";
import type { GitCommandResult } from "./git-port.js";
import { resolutionErrorDetailsSchema } from "./errors.js";
import type { ResolveMergeConflictsWorkflowOutput } from "@seqlane/runtime/workflows/resolve-merge-conflicts";
export type { ResolutionErrorDetails } from "./errors.js";

export const DEFAULT_MAX_ATTEMPTS = 10;
export const MAX_CONFLICT_PATHS = 200;
// Keep agent inputs bounded while allowing conflict-marked generated bundles
// that contain two otherwise-valid file versions.
export const MAX_AGENT_FILE_BYTES = 1024 * 1024;
export const MAX_AGENT_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_LOCKFILE_INPUT_FILES = 64;
export const MAX_LOCKFILE_INPUT_FILE_BYTES = 512 * 1024;
export const MAX_LOCKFILE_INPUT_TOTAL_BYTES = 2 * 1024 * 1024;

export const positiveIntegerSchema = z.number().int().positive().safe();
export type PositiveInteger = z.infer<typeof positiveIntegerSchema>;

export const positiveIntegerStringSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .pipe(z.custom<string>((value) => Number.isSafeInteger(Number(value))));
export type PositiveIntegerString = z.infer<typeof positiveIntegerStringSchema>;

const nonEmptyStringSchema = z.string().min(1);

export const resolutionStrategySchema = z.enum(["rebase", "merge"]);
export type ResolutionStrategy = z.infer<typeof resolutionStrategySchema>;

export const booleanInputSchema = z.enum(["true", "false"]);
export type BooleanInput = z.infer<typeof booleanInputSchema>;

export const gitRevisionSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
export type GitRevision = z.infer<typeof gitRevisionSchema>;

export const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\0\r\n]+$/);
export type BranchName = z.infer<typeof branchNameSchema>;

export const relativeDirectorySchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(
    /^(?:\.|(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)(?!.*\0)[^/]+(?:\/[^/]+)*)$/,
  );
export type RelativeDirectory = z.infer<typeof relativeDirectorySchema>;

export const conflictPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)(?!.*\0)[^/]+(?:\/[^/]+)*$/,
  );
export type ConflictPath = z.infer<typeof conflictPathSchema>;

const generatedFileGlobSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)(?!.*\0)[^/]+(?:\/[^/]+)*$/,
  )
  .refine(
    (value) => {
      let bracketDepth = 0;
      for (const character of value) {
        if (character === "[") bracketDepth += 1;
        if (character === "]") {
          if (bracketDepth === 0) return false;
          bracketDepth -= 1;
        }
      }
      return bracketDepth === 0;
    },
    { message: "Glob character classes must be balanced." },
  );
export type GeneratedFileGlob = z.infer<typeof generatedFileGlobSchema>;

const generatedFileCommandArgumentSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"));

const generatedFileCommandSchema = z
  .array(generatedFileCommandArgumentSchema)
  .min(1)
  .max(64);

export const conflictHandlerSchema = z.strictObject({
  command: generatedFileCommandSchema,
  setup: z.array(generatedFileCommandSchema).max(16).optional(),
});
export type ConflictHandler = z.infer<typeof conflictHandlerSchema>;

export const conflictHandlerRuleSchema = z.strictObject({
  match: generatedFileGlobSchema,
  outputs: z.array(generatedFileGlobSchema).min(1).max(64),
  handler: conflictHandlerSchema,
});
export type ConflictHandlerRule = z.infer<typeof conflictHandlerRuleSchema>;

export const conflictHandlersConfigSchema = z.strictObject({
  version: z.literal(1),
  rules: z.array(conflictHandlerRuleSchema).max(64),
});
export type ConflictHandlersConfig = z.infer<
  typeof conflictHandlersConfigSchema
>;

export const actionInputsSchema = z.strictObject({
  pullRequestNumber: positiveIntegerStringSchema,
  resolutionStrategy: resolutionStrategySchema.default("rebase"),
  sourceDirectory: relativeDirectorySchema,
  targetDirectory: relativeDirectorySchema,
  commit: booleanInputSchema.default("false"),
  push: booleanInputSchema.default("false"),
  maxAttempts: positiveIntegerStringSchema.default(
    String(DEFAULT_MAX_ATTEMPTS),
  ),
  conflictHandlers: z
    .string()
    .min(1)
    .max(256 * 1024)
    .default('{"version":1,"rules":[]}'),
});
export type ActionInputs = z.infer<typeof actionInputsSchema>;

export const resolveMergeConflictsRequestSchema = z.strictObject({
  pullRequestNumber: positiveIntegerSchema,
  strategy: resolutionStrategySchema,
  sourceDirectory: relativeDirectorySchema,
  targetDirectory: relativeDirectorySchema,
  commit: z.boolean(),
  push: z.boolean(),
  maxAttempts: positiveIntegerSchema,
  conflictHandlers: conflictHandlersConfigSchema.default({
    version: 1,
    rules: [],
  }),
});
export type ResolveMergeConflictsRequest = z.infer<
  typeof resolveMergeConflictsRequestSchema
>;

export const repositoryIdentitySchema = z.strictObject({
  owner: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
});
export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;

export const pullRequestMetadataSchema = z.strictObject({
  number: z.number().int().positive().safe(),
  state: z.enum(["open", "closed"]),
  baseBranch: branchNameSchema,
  headBranch: branchNameSchema,
  baseRevision: gitRevisionSchema,
  headRevision: gitRevisionSchema,
  baseRepository: repositoryIdentitySchema,
  headRepository: repositoryIdentitySchema,
  workflowRef: branchNameSchema.optional(),
  workflowRevision: gitRevisionSchema.optional(),
});
export type PullRequestMetadata = z.infer<typeof pullRequestMetadataSchema>;

export const liveBaseRevisionSchema = z.strictObject({
  branch: branchNameSchema,
  revision: gitRevisionSchema,
});
export type LiveBaseRevision = z.infer<typeof liveBaseRevisionSchema>;

export const indexStageSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type IndexStage = z.infer<typeof indexStageSchema>;

export const conflictEntrySchema = z.strictObject({
  path: conflictPathSchema,
  stage: indexStageSchema,
});
export type ConflictEntry = z.infer<typeof conflictEntrySchema>;

export const conflictSetSchema = z
  .array(conflictEntrySchema)
  .max(MAX_CONFLICT_PATHS);
export type ConflictSet = z.infer<typeof conflictSetSchema>;

export const integrationOperationSchema = z.enum(["merge", "rebase"]);
export type IntegrationOperation = z.infer<typeof integrationOperationSchema>;

export const MAX_REBASE_SUBJECT_LENGTH = 512;
export const rebaseConflictCommitSchema = z.strictObject({
  sha: gitRevisionSchema,
  subject: z.string().max(MAX_REBASE_SUBJECT_LENGTH),
});
export type RebaseConflictCommit = z.infer<typeof rebaseConflictCommitSchema>;

export const agentResolutionRequestSchema = z.strictObject({
  paths: z.array(conflictPathSchema).min(1).max(MAX_CONFLICT_PATHS),
  baseRevision: gitRevisionSchema,
  headRevision: gitRevisionSchema,
});
export type AgentResolutionRequest = z.infer<
  typeof agentResolutionRequestSchema
>;

export const workspaceFileSchema = z.strictObject({
  path: conflictPathSchema,
  bytes: z.number().int().nonnegative().max(MAX_AGENT_FILE_BYTES),
});
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export const integrationResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("clean"),
    operation: integrationOperationSchema,
    headBefore: gitRevisionSchema,
    targetRevision: gitRevisionSchema,
    headAfter: gitRevisionSchema,
  }),
  z.strictObject({
    kind: z.literal("conflicted"),
    operation: integrationOperationSchema,
    headBefore: gitRevisionSchema,
    targetRevision: gitRevisionSchema,
    conflicts: conflictSetSchema,
  }),
  z.strictObject({
    kind: z.literal("error"),
    operation: integrationOperationSchema,
    headBefore: gitRevisionSchema,
    targetRevision: gitRevisionSchema,
    exitCode: z.number().int(),
    stderr: z.string(),
    error: resolutionErrorDetailsSchema,
  }),
]);
export type IntegrationResult = z.infer<typeof integrationResultSchema>;

export const terminalOutcomeSchema = z.strictObject({
  result: z.enum(["no-change", "updated"]),
  shouldCommit: z.boolean(),
  shouldPush: z.boolean(),
});
export type TerminalOutcome = z.infer<typeof terminalOutcomeSchema>;

const resolutionSummarySchema = {
  strategy: resolutionStrategySchema,
  baseSha: gitRevisionSchema,
  headSha: gitRevisionSchema,
  attempts: z.number().int().nonnegative().safe(),
  pushed: z.boolean(),
} as const;

export const resolveMergeConflictsResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("clean"),
    result: z.literal("no-change"),
    ...resolutionSummarySchema,
  }),
  z.strictObject({
    kind: z.literal("resolved"),
    result: z.literal("updated"),
    ...resolutionSummarySchema,
  }),
  z.strictObject({
    kind: z.literal("error"),
    result: z.literal("error"),
    attempts: z.number().int().nonnegative().safe(),
    error: resolutionErrorDetailsSchema,
  }),
]);
export type ResolveMergeConflictsResult = z.infer<
  typeof resolveMergeConflictsResultSchema
>;

export interface PullRequestMetadataPort {
  readonly readPullRequest: (
    pullRequestNumber: number,
  ) => Promise<PullRequestMetadata>;
  readonly readLiveBaseRevision: (
    branch: BranchName,
  ) => Promise<LiveBaseRevision>;
}

export interface GitPort {
  readonly cwd: string;
  readonly run: (args: readonly string[]) => Promise<GitCommandResult>;
  readonly countRebaseCommits?: (baseRevision: GitRevision) => Promise<number>;
  readonly readRebaseConflictCommit?: () => Promise<
    RebaseConflictCommit | undefined
  >;
  readonly inspectState: () => Promise<{
    readonly mergeInProgress: boolean;
    readonly rebaseInProgress: boolean;
    readonly worktreeClean: boolean;
  }>;
  readonly integrate: (
    strategy: ResolutionStrategy,
    baseRevision: GitRevision,
  ) => Promise<IntegrationResult>;
  readonly readConflictSet: () => Promise<ConflictSet>;
  readonly stageConflictSet: (
    conflicts: ConflictSet,
    generatedPaths?: readonly ConflictPath[],
  ) => Promise<void>;
  readonly continueRebase: () => Promise<GitCommandResult>;
  readonly skipRebase: () => Promise<GitCommandResult>;
}

export interface WorkspaceFilesPort {
  readonly captureIntegrationBaseline?: () => Promise<void>;
  readonly prepareAgentWorkspace: (
    conflicts: ConflictSet,
  ) => Promise<AgentResolutionRequest>;
  readonly copyAgentEdits: (paths: readonly ConflictPath[]) => Promise<void>;
  readonly validateTarget: (
    conflicts: ConflictSet,
    generatedPaths?: readonly ConflictPath[],
  ) => Promise<void>;
}

export interface LockfilePort {
  readonly regenerate: () => Promise<void>;
}

export interface AgentRunnerPort {
  readonly resolve: (
    request: AgentResolutionRequest,
  ) => Promise<ResolveMergeConflictsWorkflowOutput>;
  readonly start?: () => Promise<void>;
  readonly stop?: () => Promise<void>;
  readonly getAttemptDiagnostics?: () => ResolutionAttemptDiagnostics;
}

export interface GeneratedFileHandlerPort {
  readonly run: (
    rule: ConflictHandlerRule,
    conflicts: ConflictSet,
  ) => Promise<readonly ConflictPath[]>;
}

export interface ResolutionAttemptDiagnostics {
  readonly eventCount: number;
  readonly truncated: boolean;
}

export interface ResolutionAttemptReport {
  readonly attempt: number;
  readonly commit?: {
    readonly oldSha: GitRevision;
    readonly subject: string;
  };
  readonly summary: string;
  readonly decisions: readonly ResolveMergeConflictsWorkflowOutput["decisions"][number][];
  readonly diagnostics: ResolutionAttemptDiagnostics;
}

export interface ResolutionSummaryReport {
  readonly strategy?: ResolutionStrategy;
  readonly attempts: readonly ResolutionAttemptReport[];
}

export type ResolutionProgressEvent =
  | {
      readonly kind: "started";
      readonly strategy: ResolutionStrategy;
      readonly maxAttempts: number;
      readonly commitsToReplay?: number;
    }
  | {
      readonly kind: "conflict-stop";
      readonly strategy: ResolutionStrategy;
      readonly conflictStops: number;
    }
  | {
      readonly kind: "attempt-started";
      readonly strategy: ResolutionStrategy;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly conflictStops: number;
      readonly commit?: RebaseConflictCommit;
    }
  | { readonly kind: "push-started" }
  | { readonly kind: "push-completed" }
  | {
      readonly kind: "completed";
      readonly result: "no-change" | "updated";
      readonly attempts: number;
      readonly conflictStops: number;
      readonly pushed: boolean;
    }
  | {
      readonly kind: "failed";
      readonly category: string;
      readonly code: string;
      readonly attempts: number;
      readonly conflictStops: number;
    };

export interface ProgressPort {
  readonly write: (event: ResolutionProgressEvent) => void;
}

export interface SummaryPort {
  readonly write: (
    result: ResolveMergeConflictsResult,
    report?: ResolutionSummaryReport,
  ) => Promise<void>;
}

export interface CommitAndPushPort {
  readonly commit: (baseBranch: BranchName) => Promise<void>;
  readonly beforePush?: () => Promise<void>;
  readonly push: (options: {
    readonly baseBranch: BranchName;
    readonly headBranch: BranchName;
    readonly baseRevision: GitRevision;
    readonly headRevision: GitRevision;
  }) => Promise<void>;
}

export interface ResolveMergeConflictsPorts {
  readonly github: PullRequestMetadataPort;
  readonly git: GitPort;
  readonly files: WorkspaceFilesPort;
  readonly lockfile?: LockfilePort;
  readonly generatedFiles: GeneratedFileHandlerPort;
  readonly agent: AgentRunnerPort;
  readonly summary: SummaryPort;
  readonly progress?: ProgressPort;
  readonly commitAndPush: CommitAndPushPort;
}
