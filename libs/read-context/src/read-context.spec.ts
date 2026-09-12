// @test-scope ./command-classifier.ts
// @test-scope ./hook.ts
// @test-scope ./size-estimator.ts
// @test-scope ./evidence-selection.ts
// @test-scope ./providers/openai-compatible.ts
// @test-scope ./format.ts
// @test-scope ./retrieval.ts
// @test-scope ./retrieval-workflow.ts
// @test-scope ./workflow.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorkflow } from "@seqlane/core";
import { classifyCommand } from "./command-classifier.js";
import { formatReadContextMarkdown } from "./format.js";
import { runReadContextGuard } from "./hook.js";
import { summarizeWithOpenAICompatible } from "./providers/openai-compatible.js";
import { rankCandidates, selectEvidence } from "./evidence-selection.js";
import { estimateFile } from "./size-estimator.js";
import { ReadContextSchema } from "./schemas.js";
import { retrieveEvidence } from "./retrieval.js";
import readContextWorkflow from "./workflow.js";

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
    expect(classifyCommand("rg question src").kind).toBe("allow");
    expect(classifyCommand("git status --short").kind).toBe("allow");
    expect(
      classifyCommand("seqlane run read-context.ts --input '{}'").kind,
    ).toBe("allow");
    expect(classifyCommand("cat a.ts && cat b.ts").kind).toBe("unsupported");
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
        readFile: async (path) => `${path}\ncontent`,
      },
    );
    expect(selected.selectedPaths).toEqual(["a.ts"]);
    expect(selected.excludedPaths).toContainEqual({
      path: "b.ts",
      reason: "max-files budget",
    });
  });

  it("degrades when optional retrieval tools fail", async () => {
    const run = vi.fn(async () => ({
      stdout: "",
      stderr: "missing",
      exitCode: 1,
      timedOut: false,
    }));
    const result = await retrieveEvidence(
      { question: "q", paths: ["read-context.ts"] },
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

describe("retrieval workflow fan-out", () => {
  it("runs independent evidence scrapes before selection", () => {
    const built = buildWorkflow(readContextWorkflow);
    const retrieval = built.workflowDefinitions.get(
      "workflow-read-context.retrieve",
    );

    expect(built.plan.nodes).toContainEqual(
      expect.objectContaining({
        type: "workflow",
        workflowId: "workflow-read-context.retrieve",
      }),
    );
    expect(retrieval).toBeDefined();
    const scrapeNodes = retrieval?.plan.nodes.filter(
      (node) => node.type === "task" && node.taskId.includes("-search"),
    );
    expect(scrapeNodes).toHaveLength(3);
    expect(scrapeNodes?.every((node) => node.dependsOn.length === 0)).toBe(
      true,
    );
    expect(retrieval?.plan.nodes.at(-1)).toMatchObject({
      type: "task",
      taskId: "workflow-read-context.retrieve.select-evidence",
      dependsOn: [
        "workflow-read-context.retrieve.exact-search:1",
        "workflow-read-context.retrieve.zvec-search:1",
        "workflow-read-context.retrieve.ripwire-search:1",
      ],
    });
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
});
