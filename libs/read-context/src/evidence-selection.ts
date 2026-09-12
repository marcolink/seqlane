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

export interface EvidenceSelectionOptions {
  maxFiles: number;
  maxBytes: number;
  maxChunkLines?: number;
  maxChunkBytes?: number;
  readFile: (path: string) => Promise<string>;
}

export interface EvidenceSelection {
  units: EvidenceUnit[];
  selectedPaths: string[];
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
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return value.slice(0, end);
}

function linesForRange(
  lines: readonly string[],
  range: LineRange,
  maxChunkLines: number,
): { content: string; startLine: number; endLine: number } | undefined {
  const startLine = Math.max(1, range.startLine);
  const endLine = Math.min(
    lines.length,
    startLine + maxChunkLines - 1,
    range.endLine,
  );
  if (endLine < startLine) return undefined;
  return {
    content: lines.slice(startLine - 1, endLine).join("\n"),
    startLine,
    endLine,
  };
}

export async function selectEvidence(
  candidates: readonly Candidate[],
  options: EvidenceSelectionOptions,
): Promise<EvidenceSelection> {
  const maxChunkLines = options.maxChunkLines ?? 120;
  const maxChunkBytes = options.maxChunkBytes ?? 16_000;
  const units: EvidenceUnit[] = [];
  const selectedPaths: string[] = [];
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

    let source: string;
    try {
      source = await options.readFile(candidate.path);
    } catch {
      excludedPaths.push({
        path: candidate.path,
        reason: "file could not be read",
      });
      continue;
    }

    const lines = source.split(/\r?\n/);
    const ranges = mergeRanges(candidate.ranges);
    const requestedRanges =
      ranges.length === 0
        ? [{ startLine: 1, endLine: Math.min(lines.length, maxChunkLines) }]
        : ranges;
    let fileHadContent = false;
    let fileWasBounded = false;

    for (const requestedRange of requestedRanges) {
      if (usedBytes >= options.maxBytes) break;
      const chunk = linesForRange(lines, requestedRange, maxChunkLines);
      if (chunk === undefined) continue;
      fileHadContent = true;
      if (chunk.endLine < lines.length || requestedRange.startLine > 1) {
        fileWasBounded = true;
      }

      const remainingBytes = options.maxBytes - usedBytes;
      const allowedBytes = Math.min(remainingBytes, maxChunkBytes);
      const content = takeUtf8Prefix(chunk.content, allowedBytes);
      if (content.length === 0) break;
      const contentLineCount = content.split("\n").length;
      const actualEndLine = Math.min(
        chunk.endLine,
        chunk.startLine + contentLineCount - 1,
      );
      units.push({
        path: candidate.path,
        ...(candidate.symbol === undefined ? {} : { symbol: candidate.symbol }),
        startLine: chunk.startLine,
        endLine: actualEndLine,
        content,
      });
      usedBytes += Buffer.byteLength(content, "utf8");
      if (
        content.length < chunk.content.length ||
        content.length < maxChunkBytes
      ) {
        fileWasBounded = true;
      }
    }

    if (!fileHadContent) {
      excludedPaths.push({
        path: candidate.path,
        reason: "file has no selectable lines",
      });
      continue;
    }
    selectedPaths.push(candidate.path);
    if (fileWasBounded) {
      excludedPaths.push({
        path: candidate.path,
        reason: "source was limited to bounded evidence chunks",
      });
    }
  }

  return { units, selectedPaths, excludedPaths };
}
