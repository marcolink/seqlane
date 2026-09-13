import {
  readContextInputSchema,
  ReadContextSchema,
  type ReadContextRequest,
  type ReadContextResult,
} from "./schemas.js";
import { retrieveEvidence, type RetrievalOptions } from "./retrieval.js";
import { summarizeEvidence, type SummarizerOptions } from "./summarizer.js";
import { validateReadContextReferences } from "./result-validation.js";

export * from "./schemas.js";
export { formatReadContextMarkdown } from "./format.js";
export { classifyCommand } from "./command-classifier.js";
export { estimateFile } from "./size-estimator.js";
export { retrieveEvidence } from "./retrieval.js";
export { summarizeEvidence } from "./summarizer.js";
export { validateReadContextReferences } from "./result-validation.js";
export { ReadContextSchema as readContextSchema };

export interface ReadContextOptions
  extends RetrievalOptions, SummarizerOptions {}

export async function readContext(
  request: ReadContextRequest,
  options: ReadContextOptions = {},
): Promise<ReadContextResult> {
  const parsed = readContextInputSchema.safeParse(request);
  if (!parsed.success)
    throw new TypeError(
      `Invalid read-context input: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
    );
  const retrieval = await retrieveEvidence(parsed.data, options);
  return validateReadContextReferences(
    ReadContextSchema.parse(await summarizeEvidence(retrieval, options)),
    retrieval,
  );
}
