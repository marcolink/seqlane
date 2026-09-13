import { relative, resolve } from "node:path";
import { extractExactAnchors } from "./anchors.js";
import {
  mergeCandidates,
  selectEvidence,
  type Candidate,
} from "./evidence-selection.js";
import {
  deniedPathReason,
  repositoryRelativePath,
  resolveSafePath,
  commandPathGlobs,
} from "./security.js";
import { readBoundedFile } from "./bounded-read.js";
import { nodeCommandRunner, type CommandRunner } from "./subprocess.js";
import { readContextInputSchema, type ReadContextRequest } from "./schemas.js";
import { z } from "zod";

const EXACT_SEARCH_TIMEOUT_MS = 5_000;
const OPTIONAL_SEARCH_TIMEOUT_MS = 5_000;
const RIPWIRE_SEARCH_TIMEOUT_MS = 10_000;

export interface RetrievalScrapeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RetrievalScrapes {
  readonly exact: RetrievalScrapeResult;
  readonly zvec: RetrievalScrapeResult;
  readonly ripwire: RetrievalScrapeResult;
}

const jsonTextSchema = z.string().transform((value, context) => {
  try {
    const parsed: unknown = JSON.parse(value);
    const validated = z.json().safeParse(parsed);
    if (validated.success) return validated.data;
  } catch {
    // Ignore malformed search output.
  }
  context.addIssue({ code: "custom", message: "invalid JSON" });
  return z.NEVER;
});

export interface RetrievalOptions {
  readonly root?: string;
  readonly commandRunner?: CommandRunner;
}

export interface RetrievalResult {
  readonly question: string;
  readonly corpus: string;
  readonly selectedPaths: string[];
  readonly selectedRanges: {
    path: string;
    startLine: number;
    endLine: number;
  }[];
  readonly excludedPaths: { path: string; reason: string }[];
  readonly usedExactSearch: boolean;
  readonly usedZvecGrep: boolean;
  readonly usedRipwire: boolean;
  readonly uncertainties: string[];
}

function pathCandidate(
  root: string,
  value: string,
  explicit: boolean,
  order = 0,
): Candidate | undefined {
  const absolute = resolveSafePath(root, value, "file");
  if (absolute === undefined) return undefined;
  const path = repositoryRelativePath(root, absolute);
  if (deniedPathReason(path) !== undefined) return undefined;
  return {
    path,
    explicit,
    ...(explicit ? { explicitOrder: order } : {}),
    ranges: [],
  };
}

function parseRg(
  output: string,
  root: string,
  anchors: readonly unknown[],
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const line of output.split("\n")) {
    const match =
      /"path"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)".*?"line_number"\s*:\s*(\d+)/.exec(
        line,
      );
    if (match === null) continue;
    const decoded = jsonTextSchema.safeParse(`"${match[1]}"`);
    if (!decoded.success || typeof decoded.data !== "string") continue;
    const path = decoded.data;
    const candidate = pathCandidate(root, path, false);
    if (candidate !== undefined)
      candidates.push({
        ...candidate,
        exactRank: Math.max(0, anchors.length - candidates.length),
        ranges: [
          { startLine: Number(match[2]), endLine: Number(match[2]) + 80 },
        ],
      });
  }
  return candidates;
}

function parseOptionalPaths(
  output: string,
  root: string,
  kind: "zvec" | "ripwire",
): Candidate[] {
  const candidates: Candidate[] = [];
  const pattern =
    kind === "ripwire"
      ? /p="([^"]+)"(?:[^>]*r="(\d+)")?/g
      : /(?:"path"|"file"|"source")\s*:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    const candidate = pathCandidate(root, match[1] ?? "", false);
    if (candidate !== undefined)
      candidates.push({
        ...candidate,
        ...(kind === "zvec"
          ? { zvecRank: candidates.length }
          : { ripwireRank: Number(match[2] ?? candidates.length) }),
        ranges: [],
      });
  }
  return candidates;
}

function makeCorpus(
  units: readonly {
    path: string;
    startLine: number;
    endLine: number;
    content: string;
  }[],
): string {
  return units
    .map(
      (unit) =>
        `--- ${unit.path}:${unit.startLine}-${unit.endLine} ---\n${unit.content}`,
    )
    .join("\n\n");
}

function safeScope(
  root: string,
  request: ReadContextRequest,
): { paths: string[]; invalid: boolean } {
  if (request.scope === undefined) return { paths: ["."], invalid: false };
  if (request.scope.length === 0) return { paths: [], invalid: true };
  const paths: string[] = [];
  let invalid = false;
  for (const value of request.scope) {
    const absolute = resolveSafePath(root, value, "directory");
    if (absolute === undefined) {
      invalid = true;
      continue;
    }
    paths.push(relative(root, absolute) || ".");
  }
  return { paths, invalid };
}

export function exactSearchArguments(
  request: ReadContextRequest,
  root = process.cwd(),
): string[] {
  const anchors = extractExactAnchors(request.question, request.paths ?? []);
  const scope = safeScope(resolve(root), request);
  return [
    "--json",
    "--fixed-strings",
    "--hidden",
    ...commandPathGlobs().flatMap((glob) => ["--glob", glob]),
    ...(anchors.length === 0
      ? ["-e", "__seqlane_read_context_no_exact_anchor__"]
      : anchors.slice(0, 12).flatMap(({ value }) => ["-e", value])),
    ...(scope.paths.length === 0
      ? ["__seqlane_read_context_invalid_scope_7f5a__"]
      : scope.paths),
  ];
}

export function zvecSearchArguments(request: ReadContextRequest): string[] {
  return ["search", request.question, "--json"];
}

export function ripwireSearchArguments(
  request: ReadContextRequest,
  root = process.cwd(),
): string[] {
  return [root, `--for=${request.question}`];
}

interface RetrievalCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

function retrievalCommandSpecs(
  request: ReadContextRequest,
  root: string,
): {
  exact: RetrievalCommandSpec;
  zvec?: RetrievalCommandSpec;
  ripwire?: RetrievalCommandSpec;
} {
  return {
    exact: {
      command: "rg",
      args: exactSearchArguments(request, root),
      timeoutMs: EXACT_SEARCH_TIMEOUT_MS,
      maxOutputBytes: 256_000,
    },
    ...(request.noZvec
      ? {}
      : {
          zvec: {
            command: "zg",
            args: zvecSearchArguments(request),
            timeoutMs: OPTIONAL_SEARCH_TIMEOUT_MS,
            maxOutputBytes: 128_000,
          },
        }),
    ...(request.noRipwire
      ? {}
      : {
          ripwire: {
            command: "ripwire",
            args: ripwireSearchArguments(request, root),
            timeoutMs: RIPWIRE_SEARCH_TIMEOUT_MS,
            maxOutputBytes: 128_000,
          },
        }),
  };
}

function emptyScrapeResult(): RetrievalScrapeResult {
  return { exitCode: 127, stdout: "", stderr: "unavailable" };
}

interface OptionalCandidateResult {
  readonly candidates: Candidate[];
  readonly uncertainties: string[];
  readonly usedZvecGrep: boolean;
  readonly usedRipwire: boolean;
}

function collectOptionalCandidates(
  request: ReadContextRequest,
  root: string,
  scrapes: RetrievalScrapes,
): OptionalCandidateResult {
  const candidates: Candidate[] = [];
  const uncertainties: string[] = [];
  let usedZvecGrep = false;
  let usedRipwire = false;
  if (!request.noZvec) {
    if (scrapes.zvec.exitCode === 0) {
      const matches = parseOptionalPaths(scrapes.zvec.stdout, root, "zvec");
      if (matches.length > 0) {
        usedZvecGrep = true;
        candidates.push(...matches);
      } else uncertainties.push("zvec-grep returned no usable source location");
    } else
      uncertainties.push(
        "zvec-grep was unavailable or returned no usable result",
      );
  }
  if (!request.noRipwire) {
    if (scrapes.ripwire.exitCode === 0) {
      const matches = parseOptionalPaths(
        scrapes.ripwire.stdout,
        root,
        "ripwire",
      );
      if (matches.length > 0) {
        usedRipwire = true;
        candidates.push(...matches);
      } else uncertainties.push("Ripwire returned no usable source location");
    } else
      uncertainties.push(
        "Ripwire was unavailable or returned no usable result",
      );
  }
  return { candidates, uncertainties, usedZvecGrep, usedRipwire };
}

export async function retrieveEvidenceFromScrapes(
  request: ReadContextRequest,
  scrapes: RetrievalScrapes,
  options: Pick<RetrievalOptions, "root"> = {},
): Promise<RetrievalResult> {
  const parsedRequest = readContextInputSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new TypeError(
      `Invalid read-context input: ${parsedRequest.error.issues[0]?.message ?? "invalid input"}`,
    );
  }
  const root = resolve(options.root ?? process.cwd());
  const excludedPaths: { path: string; reason: string }[] = [];
  const explicit = (request.paths ?? []).flatMap((path, index) => {
    const candidate = pathCandidate(root, path, true, index);
    if (candidate === undefined)
      excludedPaths.push({
        path,
        reason: "outside root, missing, or denied path",
      });
    return candidate === undefined ? [] : [candidate];
  });
  const anchors = extractExactAnchors(request.question, request.paths ?? []);
  const scope = safeScope(root, request);
  const exactCandidates =
    scrapes.exact.exitCode === 0
      ? parseRg(scrapes.exact.stdout, root, anchors)
      : [];
  const optional = collectOptionalCandidates(request, root, scrapes);
  const uncertainties = [...optional.uncertainties];
  if (scope.invalid)
    uncertainties.push(
      "One or more requested search scopes were invalid, missing, denied, or empty",
    );
  const selection = await selectEvidence(
    mergeCandidates([...explicit, ...exactCandidates, ...optional.candidates]),
    {
      maxFiles: request.maxFiles ?? 12,
      maxBytes: request.maxBytes ?? 16_000,
      readFile: async (path, readRequest) =>
        readBoundedFile(root, path, readRequest),
    },
  );
  const allExcluded = [...excludedPaths, ...selection.excludedPaths];
  if (
    allExcluded.some(
      ({ reason }) => reason.includes("budget") || reason.includes("bounded"),
    )
  )
    uncertainties.push(
      "Evidence was truncated or excluded by configured file/byte limits",
    );
  if (selection.units.length === 0)
    uncertainties.push(
      "No readable source evidence matched the question or supplied paths",
    );
  return {
    question: request.question,
    corpus: makeCorpus(selection.units),
    selectedPaths: selection.selectedPaths,
    selectedRanges: selection.selectedRanges,
    excludedPaths: allExcluded,
    usedExactSearch: anchors.length > 0,
    usedZvecGrep: optional.usedZvecGrep,
    usedRipwire: optional.usedRipwire,
    uncertainties,
  };
}

export async function retrieveEvidence(
  request: ReadContextRequest,
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const root = resolve(options.root ?? process.cwd());
  const run = options.commandRunner ?? nodeCommandRunner;
  const specs = retrievalCommandSpecs(request, root);
  const runSpec = async (
    spec: RetrievalCommandSpec | undefined,
  ): Promise<RetrievalScrapeResult> => {
    if (spec === undefined) return emptyScrapeResult();
    const result = await run(spec.command, spec.args, {
      cwd: root,
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const [exact, zvec, ripwire] = await Promise.all([
    runSpec(specs.exact),
    runSpec(specs.zvec),
    runSpec(specs.ripwire),
  ]);
  return retrieveEvidenceFromScrapes(
    request,
    { exact, zvec, ripwire },
    { root },
  );
}
