import {
  ReadContextSchema,
  type ReadContextResult,
  type ReadContextRetrieval,
} from "./schemas.js";

function rangeIsSelected(
  path: string,
  startLine: number,
  endLine: number,
  retrieval: ReadContextRetrieval,
): boolean {
  if (startLine > endLine) return false;
  return retrieval.selectedRanges.some(
    (range) =>
      range.path === path &&
      startLine >= range.startLine &&
      endLine <= range.endLine,
  );
}

export function validateReadContextReferences(
  result: ReadContextResult,
  retrieval: ReadContextRetrieval,
): ReadContextResult {
  const selectedPaths = new Set(retrieval.selectedPaths);
  let removedReference = false;
  const evidence = result.evidence.filter((item) => {
    const validPath = selectedPaths.has(item.path);
    const hasRange = item.startLine !== undefined || item.endLine !== undefined;
    const validRange =
      !hasRange ||
      (item.startLine !== undefined &&
        item.endLine !== undefined &&
        rangeIsSelected(item.path, item.startLine, item.endLine, retrieval));
    if (!validPath || !validRange) removedReference = true;
    return validPath && validRange;
  });
  const followUpReads = result.followUpReads.filter((item) => {
    const valid =
      selectedPaths.has(item.path) &&
      rangeIsSelected(item.path, item.startLine, item.endLine, retrieval);
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
      selectedPaths: retrieval.selectedPaths,
      selectedRanges: retrieval.selectedRanges,
      excludedPaths: retrieval.excludedPaths,
      usedExactSearch: retrieval.usedExactSearch,
      usedZvecGrep: retrieval.usedZvecGrep,
      usedRipwire: retrieval.usedRipwire,
    },
  });
}
