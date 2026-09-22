import {
  ReadContextSchema,
  type ReadContextResult,
  type ReadContextRetrieval,
} from "./schemas.js";

export function validateReadContextReferences(
  result: ReadContextResult,
  retrieval: ReadContextRetrieval,
): ReadContextResult {
  const selectedPaths = new Set(result.retrieval.selectedPaths);
  const selectedRanges = result.retrieval.selectedRanges;
  let removedReference = false;
  const evidence = result.evidence.filter((item) => {
    const validPath = selectedPaths.has(item.path);
    const hasRange = item.startLine !== undefined || item.endLine !== undefined;
    const validRange =
      !hasRange ||
      (item.startLine !== undefined &&
        item.endLine !== undefined &&
        selectedRanges.some(
          (range) =>
            range.path === item.path &&
            item.startLine! >= range.startLine &&
            item.endLine! <= range.endLine,
        ));
    if (!validPath || !validRange) removedReference = true;
    return validPath && validRange;
  });
  const followUpReads = result.followUpReads.filter((item) => {
    const valid =
      selectedPaths.has(item.path) &&
      selectedRanges.some(
        (range) =>
          range.path === item.path &&
          item.startLine >= range.startLine &&
          item.endLine <= range.endLine,
      );
    if (!valid) removedReference = true;
    return valid;
  });
  return ReadContextSchema.parse({
    ...result,
    evidence,
    followUpReads,
    uncertainties: [
      ...new Set([
        ...result.uncertainties,
        ...(removedReference
          ? [
              "The model returned evidence or follow-up references outside the retrieved source ranges; invalid references were removed",
            ]
          : []),
      ]),
    ].slice(0, 12),
    retrieval: {
      selectedPaths: result.retrieval.selectedPaths,
      selectedRanges: result.retrieval.selectedRanges,
      excludedPaths: retrieval.excludedPaths,
      usedExactSearch: retrieval.usedExactSearch,
      usedZvecGrep: retrieval.usedZvecGrep,
      usedRipwire: retrieval.usedRipwire,
    },
  });
}
