// @test-scope ./command-classifier.ts
// @test-scope ./hook.ts
// @test-scope ./size-estimator.ts
// @test-scope ./evidence-selection.ts
// @test-scope ./providers/openai-compatible.ts
// @test-scope ./format.ts
// @test-scope ./retrieval.ts
// @test-scope ./result-validation.ts
// @test-scope ./summarization-contract.ts
// @test-scope ./bounded-read.ts
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyCommand } from "./command-classifier.js";
import { formatReadContextMarkdown } from "./format.js";
import { runReadContextGuard } from "./hook.js";
import { summarizeWithOpenAICompatible } from "./providers/openai-compatible.js";
import { rankCandidates, selectEvidence } from "./evidence-selection.js";
import { readBoundedFile } from "./bounded-read.js";
import { validateReadContextReferences } from "./result-validation.js";
import { estimateFile } from "./size-estimator.js";
import { ReadContextSchema } from "./schemas.js";
import {
  exactSearchArguments,
  retrieveEvidence,
  retrieveEvidenceFromScrapes,
} from "./retrieval.js";
import { mergeReadContextUncertainties } from "./summarization-contract.js";

afterEach(() => vi.unstubAllEnvs());

describe("command classification and hook policy", () => {
  it.each(["cat source.ts", "less source.ts", "more source.ts"])(
    "classifies %s as a full read",
    (command) => {
      expect(classifyCommand(command)).toMatchObject({
        kind: "full",
        path: "source.ts",
      });
    },
  );

  it.each([
    "head -n 20 source.ts",
    "tail -n 20 source.ts",
    "sed -n '10,30p' source.ts",
  ])("classifies %s as bounded", (command) => {
    expect(classifyCommand(command).kind).toBe("bounded");
  });

  it("allows searches, workflow calls, metadata, and unsupported compounds", () => {
    expect(classifyCommand("rg question src").kind).toBe("path-bearing");
    expect(classifyCommand("git status --short -- .").kind).toBe(
      "path-bearing",
    );
    expect(classifyCommand("git status --short").kind).toBe("unsafe");
    expect(
      classifyCommand(
        "pnpm exec node apps/cli/bin/run.js run ./workflows/read-context/workflow.ts --input '{}' --workspace .",
      ).kind,
    ).toBe("workflow");
    expect(classifyCommand("cat workflows/read-context/workflow.ts").kind).toBe(
      "full",
    );
    expect(
      classifyCommand("cat /tmp/workflows/read-context/workflow.ts").kind,
    ).toBe("full");
    expect(classifyCommand("cat a.ts && cat b.ts").kind).toBe("unsupported");
  });

  it("denies unscoped and unsupported read command forms", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-command-forms-"));
    await writeFile(join(root, ".env"), "TOKEN=secret");
    const previous = process.cwd();
    process.chdir(root);
    try {
      for (const command of [
        "rg --hidden TOKEN",
        "git grep TOKEN",
        "git diff",
        "git log",
        "cat -- .env",
      ]) {
        expect(
          JSON.parse(
            runReadContextGuard(JSON.stringify({ tool_input: { command } })),
          ),
        ).toMatchObject({
          hookSpecificOutput: { permissionDecision: "deny" },
        });
      }
    } finally {
      process.chdir(previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects sensitive paths from direct and path-bearing commands", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-sensitive-hook-"));
    await writeFile(join(root, ".env"), "TOKEN=secret");
    const previous = process.cwd();
    const previousRoot = process.env.SEQLANE_READ_CONTEXT_ROOT;
    process.env.SEQLANE_READ_CONTEXT_ROOT = root;
    process.chdir(root);
    try {
      for (const command of [
        "cat .env",
        "rg secret .env",
        "grep secret .env",
        "git grep secret -- .env",
        "git show HEAD:.env",
        "git diff -- .env",
        "git status --short -- .env",
        "git log -- .env",
        "rg secret /tmp/.env",
      ]) {
        expect(
          JSON.parse(
            runReadContextGuard(JSON.stringify({ tool_input: { command } })),
          ),
        ).toMatchObject({
          hookSpecificOutput: { permissionDecision: "deny" },
        });
      }
    } finally {
      process.chdir(previous);
      if (previousRoot === undefined)
        delete process.env.SEQLANE_READ_CONTEXT_ROOT;
      else process.env.SEQLANE_READ_CONTEXT_ROOT = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns valid deny JSON for an oversized file and no debug noise on stdout", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-hook-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "large.ts"), `${"line\n".repeat(8)}`);
    vi.stubEnv("READ_CONTEXT_MAX_LINES", "3");
    const previous = process.cwd();
    process.chdir(root);
    try {
      const output = runReadContextGuard(
        JSON.stringify({ tool_input: { command: "cat large.ts" } }),
      );
      const parsed = JSON.parse(output) as unknown;
      expect(parsed).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(output).not.toContain("undefined");
      expect(
        runReadContextGuard(
          JSON.stringify({ tool_input: { command: "head -n 5 large.ts" } }),
        ),
      ).toBe("{}");
    } finally {
      process.chdir(previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only the validated repository-local workflow invocation", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-workflow-hook-"));
    await mkdir(join(root, "apps/cli/bin"), { recursive: true });
    await mkdir(join(root, "workflows/read-context"), { recursive: true });
    await writeFile(join(root, "apps/cli/bin/run.js"), "runner");
    await writeFile(
      join(root, "workflows/read-context/workflow.ts"),
      "workflow",
    );
    const previous = process.cwd();
    process.chdir(root);
    try {
      const command =
        'pnpm exec node apps/cli/bin/run.js run ./workflows/read-context/workflow.ts --input \'{"question":"q"}\' --adapter codex --workspace .';
      expect(
        runReadContextGuard(JSON.stringify({ tool_input: { command } })),
      ).toBe("{}");
      const wrongAdapter = runReadContextGuard(
        JSON.stringify({
          tool_input: {
            command: command.replace("--adapter codex", "--adapter opencode"),
          },
        }),
      );
      expect(JSON.parse(wrongAdapter)).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      const missingAdapter = runReadContextGuard(
        JSON.stringify({
          tool_input: {
            command: command.replace(" --adapter codex", ""),
          },
        }),
      );
      expect(JSON.parse(missingAdapter)).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    } finally {
      process.chdir(previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked evidence paths", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-symlink-"));
    const outside = await mkdtemp(join("/tmp", "read-context-outside-"));
    try {
      const outsideFile = join(outside, "secret.ts");
      const linkedFile = join(root, "linked.ts");
      await writeFile(outsideFile, "secret");
      await symlink(outsideFile, linkedFile);
      expect(estimateFile(linkedFile, { root })).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("finalizes the last selected line at EOF without a trailing newline", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-eof-"));
    try {
      const path = join(root, "source.ts");
      await writeFile(path, "a\nb\nc");
      expect(
        readBoundedFile(root, path, {
          startLine: 1,
          endLine: 10,
          maxBytes: 100,
          maxScanBytes: 100,
        }),
      ).toMatchObject({ content: "a\nb\nc", startLine: 1, endLine: 3 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("size and evidence budgets", () => {
  it("estimates line and byte thresholds and fails open for missing files", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-size-"));
    const path = join(root, "file.ts");
    await writeFile(path, "a\nb\n");
    expect(estimateFile(path)).toMatchObject({ bytes: 4, lines: 3 });
    expect(estimateFile(join(root, "missing.ts"))).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  it("ranks explicit paths first, deduplicates, and reports file/byte limits", async () => {
    expect(
      rankCandidates([
        { path: "z.ts", explicit: false, ripwireRank: 1, ranges: [] },
        { path: "a.ts", explicit: true, explicitOrder: 0, ranges: [] },
      ])[0]?.path,
    ).toBe("a.ts");
    const selected = await selectEvidence(
      [
        { path: "a.ts", explicit: true, explicitOrder: 0, ranges: [] },
        { path: "b.ts", explicit: false, exactRank: 1, ranges: [] },
      ],
      {
        maxFiles: 1,
        maxBytes: 20,
        readFile: async (path, request) => ({
          content: `${path}\ncontent`,
          startLine: request.startLine,
          endLine: request.endLine,
          truncated: false,
        }),
      },
    );
    expect(selected.selectedPaths).toEqual(["a.ts"]);
    expect(selected.excludedPaths).toContainEqual({
      path: "b.ts",
      reason: "max-files budget",
    });
  });

  it("does not mark a complete short read as bounded", async () => {
    const selected = await selectEvidence(
      [{ path: "a.ts", explicit: true, ranges: [] }],
      {
        maxFiles: 1,
        maxBytes: 100,
        maxChunkBytes: 50,
        readFile: async (_path, request) => ({
          content: "short source",
          startLine: request.startLine,
          endLine: 1,
          truncated: false,
        }),
      },
    );
    expect(selected.excludedPaths).toEqual([]);
  });

  it("does not broaden an invalid search scope to the repository root", () => {
    expect(
      exactSearchArguments(
        { question: "q", scope: ["missing-directory"] },
        process.cwd(),
      ),
    ).toContain("__seqlane_read_context_invalid_scope_7f5a__");
  });

  it("excludes evidence that exceeds the bounded scan-work limit", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-scan-limit-"));
    try {
      const path = join(root, "source.ts");
      await writeFile(path, `${"line\n".repeat(60_000)}`);
      const result = await retrieveEvidenceFromScrapes(
        { question: "q", paths: ["source.ts"] },
        {
          exact: {
            exitCode: 0,
            stdout: '{"path":{"text":"source.ts"},"line_number":40000}',
            stderr: "",
          },
          zvec: { exitCode: 1, stdout: "", stderr: "disabled" },
          ripwire: { exitCode: 1, stdout: "", stderr: "disabled" },
        },
        { root },
      );
      expect(result.selectedPaths).toEqual([]);
      expect(result.uncertainties).toEqual(
        expect.arrayContaining([expect.stringContaining("scan-work limit")]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies one scan-work budget across disjoint candidate reads", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-scan-budget-"));
    try {
      await writeFile(join(root, "a.ts"), "x\n".repeat(10_000));
      await writeFile(join(root, "b.ts"), "x\n".repeat(10_000));
      const selected = await selectEvidence(
        [
          {
            path: "a.ts",
            explicit: true,
            ranges: [{ startLine: 1, endLine: 1 }],
          },
          {
            path: "b.ts",
            explicit: true,
            ranges: [{ startLine: 1, endLine: 1 }],
          },
        ],
        {
          maxFiles: 2,
          maxBytes: 100,
          maxScanBytes: 8_192,
          readFile: async (path, request) =>
            readBoundedFile(root, path, request),
        },
      );
      expect(selected.selectedPaths).toEqual(["a.ts"]);
      expect(selected.excludedPaths).toContainEqual({
        path: "b.ts",
        reason: "scan-work budget",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps oversized evidence requests before corpus construction", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-corpus-limit-"));
    try {
      await writeFile(join(root, "source.ts"), `${"line\n".repeat(10_000)}`);
      const result = await retrieveEvidenceFromScrapes(
        { question: "q", paths: ["source.ts"], maxBytes: 40_000 },
        {
          exact: { exitCode: 1, stdout: "", stderr: "none" },
          zvec: { exitCode: 1, stdout: "", stderr: "disabled" },
          ripwire: { exitCode: 1, stdout: "", stderr: "disabled" },
        },
        { root },
      );
      expect(Buffer.byteLength(result.corpus, "utf8")).toBeLessThanOrEqual(
        32_000,
      );
      expect(result.uncertainties).toEqual(
        expect.arrayContaining([
          expect.stringContaining("capped at 32000 bytes"),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops a partially retained corpus unit and its citation range", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-corpus-range-"));
    try {
      const content = `${"x".repeat(135)}\n`.repeat(120);
      await writeFile(join(root, "a.ts"), content);
      await writeFile(join(root, "b.ts"), content);
      const result = await retrieveEvidenceFromScrapes(
        {
          question: "q",
          paths: ["a.ts", "b.ts"],
          maxBytes: 40_000,
        },
        {
          exact: { exitCode: 1, stdout: "", stderr: "none" },
          zvec: { exitCode: 1, stdout: "", stderr: "disabled" },
          ripwire: { exitCode: 1, stdout: "", stderr: "disabled" },
        },
        { root },
      );
      expect(result.selectedPaths).toEqual(["a.ts"]);
      expect(result.selectedRanges).toHaveLength(1);
      expect(result.selectedRanges[0]?.path).toBe("a.ts");
      expect(result.excludedPaths).toContainEqual({
        path: "b.ts",
        reason: "corpus byte budget",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses normalized input at the exported retrieval boundary", async () => {
    const root = await mkdtemp(join("/tmp", "read-context-normalized-input-"));
    try {
      await writeFile(join(root, "source.ts"), "source\n");
      const result = await retrieveEvidenceFromScrapes(
        {
          question: " q ",
          paths: [" source.ts "],
          maxBytes: 40_000,
          extra: "ignored",
        } as unknown as Parameters<typeof retrieveEvidenceFromScrapes>[0],
        {
          exact: { exitCode: 1, stdout: "", stderr: "none" },
          zvec: { exitCode: 1, stdout: "", stderr: "disabled" },
          ripwire: { exitCode: 1, stdout: "", stderr: "disabled" },
        },
        { root },
      );
      expect(result.question).toBe("q");
      expect(result.selectedPaths).toEqual(["source.ts"]);
      expect(result.uncertainties).toEqual(
        expect.arrayContaining([expect.stringContaining("capped at 32000")]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("degrades when optional retrieval tools fail", async () => {
    const run = vi.fn(async () => ({
      stdout: "",
      stderr: "missing",
      exitCode: 1,
      timedOut: false,
    }));
    const result = await retrieveEvidence(
      { question: "q", paths: ["workflows/read-context/workflow.ts"] },
      { root: resolve(process.cwd(), "../.."), commandRunner: run },
    );
    expect(result.usedZvecGrep).toBe(false);
    expect(result.usedRipwire).toBe(false);
    expect(result.uncertainties).toEqual(
      expect.arrayContaining([
        expect.stringContaining("zvec-grep"),
        expect.stringContaining("Ripwire"),
      ]),
    );
  });
});

describe("read-context result references", () => {
  it("keeps validated ranges from bounded follow-up reads", () => {
    const retrieval = {
      question: "q",
      corpus: "src/config.ts:1-4",
      selectedPaths: ["src/config.ts"],
      selectedRanges: [{ path: "src/config.ts", startLine: 1, endLine: 4 }],
      excludedPaths: [],
      usedExactSearch: true,
      usedZvecGrep: false,
      usedRipwire: false,
      uncertainties: [],
    };
    const result = validateReadContextReferences(
      {
        answer: "answer",
        evidence: [
          {
            path: "outside.ts",
            startLine: 1,
            endLine: 2,
            relevance: "invalid",
          },
          {
            path: "src/config.ts",
            startLine: 1,
            endLine: 4,
            relevance: "valid",
          },
          {
            path: "src/runtime.ts",
            startLine: 1,
            endLine: 3,
            relevance: "follow-up",
          },
        ],
        relationships: [],
        followUpReads: [
          { path: "src/config.ts", startLine: 2, endLine: 3, reason: "valid" },
          {
            path: "src/config.ts",
            startLine: 5,
            endLine: 6,
            reason: "invalid",
          },
        ],
        uncertainties: [],
        retrieval: {
          ...retrieval,
          selectedPaths: ["src/config.ts", "src/runtime.ts"],
          selectedRanges: [
            ...retrieval.selectedRanges,
            { path: "src/runtime.ts", startLine: 1, endLine: 3 },
          ],
        },
      },
      retrieval,
    );
    expect(result.evidence).toHaveLength(2);
    expect(result.followUpReads).toHaveLength(1);
    expect(result.retrieval.selectedPaths).toEqual([
      "src/config.ts",
      "src/runtime.ts",
    ]);
    expect(result.retrieval.selectedRanges).toContainEqual({
      path: "src/runtime.ts",
      startLine: 1,
      endLine: 3,
    });
    expect(result.uncertainties).toEqual(
      expect.arrayContaining([
        expect.stringContaining("outside the retrieved source ranges"),
      ]),
    );
  });

  it("reports follow-up range trimming instead of hiding it", () => {
    const retrieval = {
      question: "q",
      corpus: "src/config.ts:1-4",
      selectedPaths: ["src/config.ts"],
      selectedRanges: [{ path: "src/config.ts", startLine: 1, endLine: 4 }],
      excludedPaths: [],
      usedExactSearch: true,
      usedZvecGrep: false,
      usedRipwire: false,
      uncertainties: [],
    };
    const summary = ReadContextSchema.parse({
      answer: "answer",
      evidence: [],
      relationships: [],
      followUpReads: [],
      uncertainties: [],
      retrieval: {
        excludedPaths: retrieval.excludedPaths,
        usedExactSearch: retrieval.usedExactSearch,
        usedZvecGrep: retrieval.usedZvecGrep,
        usedRipwire: retrieval.usedRipwire,
        selectedPaths: ["src/config.ts", "src/runtime.ts"],
        selectedRanges: [
          ...retrieval.selectedRanges,
          ...Array.from({ length: 10 }, (_, index) => ({
            path: "src/runtime.ts",
            startLine: index + 1,
            endLine: index + 1,
          })),
        ],
      },
    });
    const result = mergeReadContextUncertainties(summary, retrieval);

    expect(result.truncatedFollowUpRanges).toBe(2);
    expect(result.truncatedRetrievalRanges).toBe(0);
    expect(result.retrieval.selectedRanges).toHaveLength(9);
    expect(formatReadContextMarkdown(result)).toContain(
      "2 follow-up evidence range(s) were not included",
    );
  });

  it("reports the total range trim when retrieval capacity is reached", () => {
    const retrieval = {
      question: "q",
      corpus: "src/config.ts:1-100",
      selectedPaths: ["src/config.ts"],
      selectedRanges: Array.from({ length: 100 }, (_, index) => ({
        path: "src/config.ts",
        startLine: index + 1,
        endLine: index + 1,
      })),
      excludedPaths: [],
      usedExactSearch: true,
      usedZvecGrep: false,
      usedRipwire: false,
      uncertainties: [],
    };
    const summary = ReadContextSchema.parse({
      answer: "answer",
      evidence: [],
      relationships: [],
      followUpReads: [],
      uncertainties: [],
      retrieval: {
        selectedPaths: ["src/config.ts", "src/runtime.ts"],
        selectedRanges: [{ path: "src/runtime.ts", startLine: 1, endLine: 1 }],
        excludedPaths: [],
        usedExactSearch: true,
        usedZvecGrep: false,
        usedRipwire: false,
      },
    });
    const result = mergeReadContextUncertainties(summary, retrieval);

    expect(result.truncatedFollowUpRanges).toBe(1);
    expect(result.truncatedRetrievalRanges).toBe(1);
    expect(formatReadContextMarkdown(result)).toContain(
      "1 total evidence range(s) were not included",
    );
  });
});

describe("provider and output contracts", () => {
  const modelResult = {
    answer: "The setting reaches the request.",
    evidence: [
      {
        path: "src/config.ts",
        startLine: 1,
        endLine: 4,
        relevance: "configuration",
      },
    ],
    relationships: [],
    followUpReads: [],
    uncertainties: [],
    retrieval: {
      selectedPaths: ["src/config.ts"],
      selectedRanges: [{ path: "src/config.ts", startLine: 1, endLine: 4 }],
      excludedPaths: [],
      usedExactSearch: true,
      usedZvecGrep: false,
      usedRipwire: false,
    },
  };

  it("forms an OpenAI-compatible request and validates structured output", async () => {
    vi.stubEnv("READ_CONTEXT_BASE_URL", "http://model.test/v1");
    vi.stubEnv("READ_CONTEXT_API_KEY", "secret-value");
    vi.stubEnv("READ_CONTEXT_MODEL", "cheap-model");
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer secret-value",
      });
      expect(String(init?.body)).toContain('"max_tokens":1200');
      expect(String(init?.body)).toContain("focused question");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(modelResult) } }],
        }),
        { status: 200 },
      );
    });
    await expect(
      summarizeWithOpenAICompatible(
        {
          question: "focused question",
          corpus: "src/config.ts:1-4",
          retrieval: modelResult.retrieval,
        },
        fetchMock,
      ),
    ).resolves.toMatchObject({ answer: modelResult.answer });
  });

  it("requires provider configuration and keeps markdown compact", async () => {
    await expect(
      summarizeWithOpenAICompatible(
        { question: "q", corpus: "", retrieval: modelResult.retrieval },
        vi.fn(),
      ),
    ).rejects.toThrow("READ_CONTEXT_BASE_URL");
    const parsed = ReadContextSchema.parse(modelResult);
    expect(formatReadContextMarkdown(parsed)).toContain("## Answer");
    expect(formatReadContextMarkdown(parsed)).toContain("src/config.ts:1-4");
  });

  it("rejects reversed model line ranges", () => {
    expect(
      ReadContextSchema.safeParse({
        ...modelResult,
        evidence: [
          {
            path: "src/config.ts",
            startLine: 4,
            endLine: 1,
            relevance: "reversed",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("does not expose the provider credential in HTTP errors", async () => {
    vi.stubEnv("READ_CONTEXT_BASE_URL", "http://model.test");
    vi.stubEnv("READ_CONTEXT_API_KEY", "secret-value");
    vi.stubEnv("READ_CONTEXT_MODEL", "cheap-model");
    const error = await summarizeWithOpenAICompatible(
      { question: "q", corpus: "", retrieval: modelResult.retrieval },
      vi.fn(async () => new Response("denied", { status: 401 })),
    ).catch((value: unknown) => value);
    expect(String(error)).not.toContain("secret-value");
  });

  it("bounds provider response bytes before parsing JSON", async () => {
    vi.stubEnv("READ_CONTEXT_BASE_URL", "http://model.test");
    vi.stubEnv("READ_CONTEXT_API_KEY", "secret-value");
    vi.stubEnv("READ_CONTEXT_MODEL", "cheap-model");
    await expect(
      summarizeWithOpenAICompatible(
        { question: "q", corpus: "", retrieval: modelResult.retrieval },
        vi.fn(async () => new Response("x".repeat(256_001), { status: 200 })),
      ),
    ).rejects.toThrow("256000-byte limit");
  });
});
