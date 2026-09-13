import { summarizeWithOpenAICompatible } from "./providers/openai-compatible.js";
import type { RetrievalResult } from "./retrieval.js";
import type { ReadContextResult } from "./schemas.js";

export interface SummarizerOptions {
  readonly fetchImpl?: typeof fetch;
}

export async function summarizeEvidence(
  retrieval: RetrievalResult,
  options: SummarizerOptions = {},
): Promise<ReadContextResult> {
  const result = await summarizeWithOpenAICompatible(
    {
      question: retrieval.question,
      corpus: retrieval.corpus,
      retrieval: {
        selectedPaths: retrieval.selectedPaths,
        selectedRanges: retrieval.selectedRanges,
        excludedPaths: retrieval.excludedPaths,
        usedExactSearch: retrieval.usedExactSearch,
        usedZvecGrep: retrieval.usedZvecGrep,
        usedRipwire: retrieval.usedRipwire,
      },
    },
    options.fetchImpl,
  );
  return {
    ...result,
    uncertainties: [
      ...new Set([...result.uncertainties, ...retrieval.uncertainties]),
    ].slice(0, 12),
    retrieval: {
      selectedPaths: retrieval.selectedPaths,
      selectedRanges: retrieval.selectedRanges,
      excludedPaths: retrieval.excludedPaths,
      usedExactSearch: retrieval.usedExactSearch,
      usedZvecGrep: retrieval.usedZvecGrep,
      usedRipwire: retrieval.usedRipwire,
    },
  };
}
