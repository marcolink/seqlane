import { Command, settings } from "@oclif/core";
import { safeErrorMessage, serializeSeqlaneError } from "@seqlane/protocol";
import {
  copyCommandErrorMetadata,
  parseCommandErrorMetadata,
  runCommandErrorSchema,
  type RunCommandError,
} from "./cli-contracts.js";

export const errorMessage = safeErrorMessage;

export function normalizeCommandError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(errorMessage(error), { cause: error });
}

/** Add context without dropping typed Oclif metadata or the original cause. */
export function contextualizeCommandError(
  message: string,
  cause: unknown,
): Error {
  // Oclif's normal pretty printer walks `cause` and prints a second full
  // error. Keep the source for machine serialization, but only expose the
  // native cause chain when debug output is requested.
  const contextual = settings.debug
    ? new Error(message, { cause })
    : new Error(message);
  Object.defineProperty(contextual, "originalCause", {
    configurable: true,
    value: cause,
  });
  copyCommandErrorMetadata(contextual, cause);
  return contextual;
}

export function writeDiagnostic(
  stderr: { readonly write: (value: string) => void },
  message: string,
): void {
  try {
    stderr.write(message.endsWith("\n") ? message : message + "\n");
  } catch {
    // Diagnostics are best effort and must never replace the primary result.
  }
}

export function serializeCommandError(error: unknown): RunCommandError {
  const canonical = runCommandErrorSchema.safeParse(error);
  if (canonical.success) return canonical.data;
  if (error instanceof Error) {
    const sourceCause =
      error.cause ??
      (error as Error & { readonly originalCause?: unknown }).originalCause;
    const caused = runCommandErrorSchema.safeParse(sourceCause);
    if (caused.success) {
      return { ...caused.data, message: error.message };
    }
  }
  const serialized = serializeSeqlaneError(error);
  if (!(error instanceof Error)) return runCommandErrorSchema.parse(serialized);
  const metadata = parseCommandErrorMetadata(error);
  return runCommandErrorSchema.parse({
    ...serialized,
    ...(metadata?.code === undefined ? {} : { code: metadata.code }),
    ...(metadata?.suggestions === undefined
      ? {}
      : { suggestions: metadata.suggestions }),
    ...(metadata?.ref === undefined ? {} : { ref: metadata.ref }),
  });
}

/** Shared Oclif boundary: preserve Oclif's typed errors, normalize unknowns once. */
export abstract class SeqlaneCommand extends Command {
  protected override async catch(error: unknown): Promise<unknown> {
    return super.catch(normalizeCommandError(error));
  }
}
