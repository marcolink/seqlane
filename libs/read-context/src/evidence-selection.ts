import type { ReadContextExcludedPath } from "./schemas.js";

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface Candidate {
  path: string;
  explicit: boolean;
  explicitOrder?: number;
  exactRank?: number;
  zvecRank?: number;
  ripwireRank?: number;
  ranges: LineRange[];
  symbol?: string;
}

export interface EvidenceUnit {
  path: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface EvidenceReadRequest {
  readonly startLine: number;
  readonly endLine: number;
  readonly maxBytes: number;
  readonly maxScanBytes: number;
}

export interface EvidenceReadResult {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly truncated: boolean;
  readonly excludedReason?: string;
}

export interface EvidenceSelectionOptions {
  maxFiles: number;
  maxBytes: number;
  maxChunkLines?: number;
  maxChunkBytes?: number;
  maxScanBytes?: number;
  readFile: (
    path: string,
    request: EvidenceReadRequest,
  ) => Promise<EvidenceReadResult | undefined>;
}

export interface EvidenceSelection {
  units: EvidenceUnit[];
  selectedPaths: string[];
  selectedRanges: { path: string; startLine: number; endLine: number }[];
  excludedPaths: ReadContextExcludedPath[];
}

function originRank(candidate: Candidate): number {
  if (candidate.explicit) return 0;
  if (candidate.exactRank !== undefined) return 1;
  if (candidate.zvecRank !== undefined) return 2;
  return 3;
}

function originScore(candidate: Candidate): number {
  return (
    candidate.explicitOrder ??
    candidate.exactRank ??
    candidate.zvecRank ??
    candidate.ripwireRank ??
    Number.MAX_SAFE_INTEGER
  );
}

function minDefined(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((left, right) => {
    const originDifference = originRank(left) - originRank(right);
    if (originDifference !== 0) return originDifference;
    const scoreDifference = originScore(left) - originScore(right);
    if (scoreDifference !== 0) return scoreDifference;
    return left.path.localeCompare(right.path);
  });
}

function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = ranges
    .filter(
      (range) =>
        Number.isInteger(range.startLine) &&
        Number.isInteger(range.endLine) &&
        range.startLine > 0 &&
        range.endLine >= range.startLine,
    )
    .sort((left, right) => left.startLine - right.startLine);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function mergeCandidates(candidates: readonly Candidate[]): Candidate[] {
  const byPath = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = byPath.get(candidate.path);
    if (existing === undefined) {
      byPath.set(candidate.path, {
        ...candidate,
        ranges: mergeRanges(candidate.ranges),
      });
      continue;
    }
    existing.explicit ||= candidate.explicit;
    if (candidate.explicitOrder !== undefined) {
      existing.explicitOrder = Math.min(
        existing.explicitOrder ?? Number.MAX_SAFE_INTEGER,
        candidate.explicitOrder,
      );
    }
    existing.exactRank = minDefined(existing.exactRank, candidate.exactRank);
    existing.zvecRank = minDefined(existing.zvecRank, candidate.zvecRank);
    existing.ripwireRank = minDefined(
      existing.ripwireRank,
      candidate.ripwireRank,
    );
    existing.ranges = mergeRanges([...existing.ranges, ...candidate.ranges]);
    existing.symbol ??= candidate.symbol;
  }
  return rankCandidates([...byPath.values()]);
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes)
    end -= 1;
  return value.slice(0, end);
}

function validateEvidenceBudgets(
  options: EvidenceSelectionOptions,
  maxChunkLines: number,
  maxChunkBytes: number,
  maxScanBytes: number,
): void {
  if (
    !Number.isSafeInteger(options.maxFiles) ||
    options.maxFiles <= 0 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0
  ) {
    throw new RangeError("Evidence budgets must be positive safe integers");
  }
  if (
    !Number.isSafeInteger(maxChunkLines) ||
    maxChunkLines <= 0 ||
    !Number.isSafeInteger(maxChunkBytes) ||
    maxChunkBytes <= 0
  ) {
    throw new RangeError(
      "Evidence chunk budgets must be positive safe integers",
    );
  }
  if (!Number.isSafeInteger(maxScanBytes) || maxScanBytes <= 0) {
    throw new RangeError(
      "Evidence scan budget must be a positive safe integer",
    );
  }
}

export async function selectEvidence(
  candidates: readonly Candidate[],
  options: EvidenceSelectionOptions,
): Promise<EvidenceSelection> {
  const maxChunkLines = options.maxChunkLines ?? 120;
  const maxChunkBytes = options.maxChunkBytes ?? 16_000;
  const maxScanBytes = options.maxScanBytes ?? 128_000;
  validateEvidenceBudgets(options, maxChunkLines, maxChunkBytes, maxScanBytes);
  const units: EvidenceUnit[] = [];
  const selectedPaths: string[] = [];
  const selectedRanges: {
    path: string;
    startLine: number;
    endLine: number;
  }[] = [];
  const excludedPaths: ReadContextExcludedPath[] = [];
  let usedBytes = 0;

  for (const candidate of rankCandidates(candidates)) {
    if (selectedPaths.length >= options.maxFiles) {
      excludedPaths.push({ path: candidate.path, reason: "max-files budget" });
      continue;
    }
    if (usedBytes >= options.maxBytes) {
      excludedPaths.push({ path: candidate.path, reason: "max-bytes budget" });
      continue;
    }

    const ranges = mergeRanges(candidate.ranges);
    const requestedRanges =
      ranges.length === 0 ? [{ startLine: 1, endLine: maxChunkLines }] : ranges;
    let fileHadContent = false;
    let fileWasBounded = false;
    let fileExcludedReason: string | undefined;
    const fileUnits: EvidenceUnit[] = [];
    const fileRanges: { path: string; startLine: number; endLine: number }[] =
      [];
    let fileBytes = 0;

    for (const requestedRange of requestedRanges) {
      if (usedBytes + fileBytes >= options.maxBytes) break;
      const remainingBytes = options.maxBytes - usedBytes - fileBytes;
      const allowedBytes = Math.min(remainingBytes, maxChunkBytes);
      let read: EvidenceReadResult | undefined;
      try {
        read = await options.readFile(candidate.path, {
          startLine: Math.max(1, requestedRange.startLine),
          endLine: Math.min(
            requestedRange.endLine,
            requestedRange.startLine + maxChunkLines - 1,
          ),
          maxBytes: allowedBytes,
          maxScanBytes,
        });
      } catch {
        read = undefined;
      }
      if (read === undefined) continue;
      if (read.excludedReason !== undefined) {
        fileExcludedReason = read.excludedReason;
        break;
      }
      const content = takeUtf8Prefix(read.content, allowedBytes);
      if (content.length === 0) break;
      fileHadContent = true;
      fileWasBounded ||= read.truncated || content !== read.content;
      fileUnits.push({
        path: candidate.path,
        ...(candidate.symbol === undefined ? {} : { symbol: candidate.symbol }),
        startLine: read.startLine,
        endLine: read.endLine,
        content,
      });
      fileRanges.push({
        path: candidate.path,
        startLine: read.startLine,
        endLine: read.endLine,
      });
      fileBytes += Buffer.byteLength(content, "utf8");
    }

    if (fileExcludedReason !== undefined) {
      excludedPaths.push({ path: candidate.path, reason: fileExcludedReason });
      continue;
    }
    if (!fileHadContent) {
      excludedPaths.push({
        path: candidate.path,
        reason: "file has no selectable lines",
      });
      continue;
    }
    units.push(...fileUnits);
    selectedRanges.push(...fileRanges);
    usedBytes += fileBytes;
    selectedPaths.push(candidate.path);
    if (fileWasBounded) {
      excludedPaths.push({
        path: candidate.path,
        reason: "source was limited to bounded evidence chunks",
      });
    }
  }

  return { units, selectedPaths, selectedRanges, excludedPaths };
}
