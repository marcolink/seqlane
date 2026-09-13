import {
  ReadContextSchema,
  type ReadContextResult,
  type ReadContextRetrieval,
} from "./schemas.js";

export const READ_CONTEXT_SUMMARY_SYSTEM_PROMPT =
  "You are a codebase analyst. Answer the exact question from supplied evidence only. Do not reproduce large code blocks. Cite source paths and line ranges in evidence. If evidence is incomplete, state that explicitly in uncertainties. Suggested follow-up reads must be narrow and identify why that exact range is needed. Return only JSON matching ReadContextSchema.";

export const READ_CONTEXT_SUMMARY_INSTRUCTIONS = [
  "Do not reproduce large code blocks.",
  "Cite repository-relative source paths and line ranges in evidence.",
  "Return only data matching ReadContextSchema.",
] as const;

export interface ReadContextSummarizationRequest {
  readonly question: string;
  readonly corpus: string;
  readonly retrieval: ReadContextResult["retrieval"];
}

export function createReadContextSummarizationRequest(
  question: string,
  corpus: string,
  retrieval: ReadContextResult["retrieval"],
): ReadContextSummarizationRequest {
  return {
    question,
    corpus,
    retrieval,
  };
}

export function formatReadContextSummaryPrompt(
  request: Pick<ReadContextSummarizationRequest, "question" | "corpus">,
): string {
  return `Question: ${request.question}\n\nEvidence:\n${request.corpus}`;
}

export function mergeReadContextUncertainties(
  summary: ReadContextResult,
  retrieval: ReadContextRetrieval,
): ReadContextResult {
  return ReadContextSchema.parse({
    ...summary,
    uncertainties: [
      ...new Set([...summary.uncertainties, ...retrieval.uncertainties]),
    ].slice(0, 12),
    retrieval: {
      selectedPaths: retrieval.selectedPaths,
      selectedRanges: retrieval.selectedRanges,
      excludedPaths: retrieval.excludedPaths,
      usedExactSearch: retrieval.usedExactSearch,
      usedZvecGrep: retrieval.usedZvecGrep,
      usedRipwire: retrieval.usedRipwire,
    },
  });
}
