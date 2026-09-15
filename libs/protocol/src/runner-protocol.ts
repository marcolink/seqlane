import { z } from "zod";
import { jsonValueSchema, plainRecordSchema } from "@seqlane/core";

const workflowReferenceSchema = plainRecordSchema.pipe(
  z.strictObject({
    id: z.string().min(1),
    moduleSpecifier: z.string().min(1),
    exportName: z.string().min(1),
  }),
);

export const runtimeProfileReferenceSchema = plainRecordSchema.pipe(
  z.strictObject({
    id: z.string().min(1),
    workspace: z.string().min(1).optional(),
  }),
);

const runRequestSchema = plainRecordSchema.pipe(
  z.strictObject({
    type: z.literal("run.start"),
    workflow: workflowReferenceSchema,
    input: jsonValueSchema,
    runtime: runtimeProfileReferenceSchema,
    dryRun: z.boolean().optional(),
  }),
);

const cancelRunSchema = plainRecordSchema.pipe(
  z.strictObject({ type: z.literal("run.cancel") }),
);

const runnerCommandSchema = z.union([runRequestSchema, cancelRunSchema]);

export type WorkflowReference = Readonly<
  z.output<typeof workflowReferenceSchema>
>;
export type RuntimeProfileReference = Readonly<
  z.output<typeof runtimeProfileReferenceSchema>
>;
export type RunRequest = Readonly<
  Omit<z.output<typeof runRequestSchema>, "workflow" | "runtime">
> & {
  readonly workflow: WorkflowReference;
  readonly runtime: RuntimeProfileReference;
};
export type CancelRun = Readonly<z.output<typeof cancelRunSchema>>;
export type RunnerCommand = z.output<typeof runnerCommandSchema>;

export function isWorkflowReference(
  value: unknown,
): value is WorkflowReference {
  try {
    return workflowReferenceSchema.safeParse(value).success;
  } catch {
    return false;
  }
}

export function isRuntimeProfileReference(
  value: unknown,
): value is RuntimeProfileReference {
  try {
    return runtimeProfileReferenceSchema.safeParse(value).success;
  } catch {
    return false;
  }
}

export function isRunRequest(value: unknown): value is RunRequest {
  try {
    return runRequestSchema.safeParse(value).success;
  } catch {
    return false;
  }
}

export function isCancelRun(value: unknown): value is CancelRun {
  try {
    return cancelRunSchema.safeParse(value).success;
  } catch {
    return false;
  }
}

export function isRunnerCommand(value: unknown): value is RunnerCommand {
  try {
    return runnerCommandSchema.safeParse(value).success;
  } catch {
    return false;
  }
}

export function encodeRunnerCommand(command: RunnerCommand): string {
  let valid = false;
  try {
    valid = runnerCommandSchema.safeParse(command).success;
  } catch {
    // Normalize schema failures at the protocol boundary.
  }
  if (!valid) {
    throw new TypeError("Invalid runner command");
  }

  try {
    const encoded = JSON.stringify(command);
    if (encoded === undefined) throw new TypeError();
    return encoded;
  } catch {
    throw new TypeError("Invalid runner command");
  }
}

export function decodeRunnerCommand(encoded: string): RunnerCommand {
  if (typeof encoded !== "string")
    throw new TypeError("Invalid runner command");

  try {
    const decoded: unknown = JSON.parse(encoded);
    const result = runnerCommandSchema.safeParse(decoded);
    if (result.success) return result.data;
  } catch {
    // Normalize parser and validation failures at the protocol boundary.
  }

  throw new TypeError("Invalid runner command");
}
