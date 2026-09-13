import { summarizeWithOpenAICompatible } from "./providers/openai-compatible.js";
import type { RetrievalResult } from "./retrieval.js";
import {
  createReadContextSummarizationRequest,
  mergeReadContextUncertainties,
} from "./summarization-contract.js";
import type { ReadContextResult } from "./schemas.js";

export interface SummarizerOptions {
  readonly fetchImpl?: typeof fetch;
}

export async function summarizeEvidence(
  retrieval: RetrievalResult,
  options: SummarizerOptions = {},
): Promise<ReadContextResult> {
  const result = await summarizeWithOpenAICompatible(
    createReadContextSummarizationRequest(
      retrieval.question,
      retrieval.corpus,
      {
        selectedPaths: retrieval.selectedPaths,
        selectedRanges: retrieval.selectedRanges,
        excludedPaths: retrieval.excludedPaths,
        usedExactSearch: retrieval.usedExactSearch,
        usedZvecGrep: retrieval.usedZvecGrep,
        usedRipwire: retrieval.usedRipwire,
      },
    ),
    options.fetchImpl,
  );
  return mergeReadContextUncertainties(result, {
    question: retrieval.question,
    corpus: retrieval.corpus,
    selectedPaths: retrieval.selectedPaths,
    selectedRanges: retrieval.selectedRanges,
    excludedPaths: retrieval.excludedPaths,
    usedExactSearch: retrieval.usedExactSearch,
    usedZvecGrep: retrieval.usedZvecGrep,
    usedRipwire: retrieval.usedRipwire,
    uncertainties: retrieval.uncertainties,
  });
}
