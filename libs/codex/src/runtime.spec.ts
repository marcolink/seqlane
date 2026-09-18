// @test-scope ./runtime.ts
import type { AgentAdapter } from "@seqlane/agent-adapter";
import { defineTask } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CODEX_AGENT_CAPABILITIES } from "./capabilities.js";
import { createCodexRun, type CodexRun } from "./run.js";
import { createCodexAgentRuntimeFactory } from "./runtime.js";

vi.mock("./run.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./run.js")>();
  return { ...original, createCodexRun: vi.fn(original.createCodexRun) };
});

const executable = "/private/bin/codex-secret";
const workspace = "/private/workspace-secret";

function factory() {
  return createCodexAgentRuntimeFactory({
    adapter: "codex",
    executable,
    networkAccess: false,
  });
}

function failingRun(adapter: AgentAdapter): CodexRun {
  const modelCapabilities: CodexRun["modelCapabilities"] = {
    executor: "codex",
    listModels: async () => {
      throw new Error(`model list failed for ${executable}`);
    },
    resolveDefaultModel: async () => {
      throw new Error(`default model failed for ${workspace}`);
    },
  };
  return {
    modelCapabilities,
    createAdapter: () => adapter,
    close: async () => {
      throw new Error(`close failed for ${workspace}`);
    },
  };
}

describe("Codex agent runtime composition", () => {
  it("creates one run-scoped runtime with matching adapter capabilities", async () => {
    const factory = createCodexAgentRuntimeFactory({
      adapter: "codex",
      executable: "/opt/codex",
      networkAccess: false,
    });
    const runtime = await factory(
      new AbortController().signal,
      "/workspace-from-composition",
    );
    const adapter = runtime.createAdapter({
      signal: new AbortController().signal,
      requestContext: undefined,
    });

    expect(runtime).toMatchObject({
      identity: "codex",
      capabilities: {
        execute: true,
        modelSelection: true,
        checkpoint: true,
        fork: true,
      },
    });
    expect(adapter.capabilities).toEqual(runtime.capabilities);
    await runtime.close?.();
  });

  it("requires composition to supply a workspace", async () => {
    const factory = createCodexAgentRuntimeFactory({
      adapter: "codex",
      executable: "/opt/codex",
    });

    await expect(
      factory(new AbortController().signal, undefined),
    ).rejects.toThrow("Codex requires a workspace");
  });

  it("redacts runtime and adapter construction failures", async () => {
    vi.mocked(createCodexRun).mockImplementationOnce(() => {
      throw new Error(`could not start ${executable} in ${workspace}`);
    });
    await expect(
      factory()(new AbortController().signal, workspace),
    ).rejects.toThrow("could not start [REDACTED] in [REDACTED]");

    const run = failingRun({
      capabilities: CODEX_AGENT_CAPABILITIES,
      execute: async () => undefined,
    });
    run.createAdapter = () => {
      throw new Error(`adapter failed for ${executable}`);
    };
    vi.mocked(createCodexRun).mockReturnValueOnce(run);
    const runtime = await factory()(new AbortController().signal, workspace);

    expect(() =>
      runtime.createAdapter({
        signal: new AbortController().signal,
        requestContext: undefined,
      }),
    ).toThrow("adapter failed for [REDACTED]");
  });

  it("redacts every exposed runtime and adapter operation", async () => {
    const diagnostics: string[] = [];
    const adapter: AgentAdapter = {
      capabilities: CODEX_AGENT_CAPABILITIES,
      execute: async (request) => {
        request.onDiagnostic?.({
          code: "codex-test",
          message: `diagnostic from ${executable}`,
        });
        throw new Error(`execution failed in ${workspace}`);
      },
      close: async () => {
        throw new Error(`adapter close failed for ${executable}`);
      },
      captureCheckpoint: async () => {
        throw new Error(`checkpoint failed in ${workspace}`);
      },
      fork: async () => {
        throw new Error(`fork failed for ${executable}`);
      },
      sessionUi: async () => {
        throw new Error(`session UI failed in ${workspace}`);
      },
    };
    vi.mocked(createCodexRun).mockReturnValueOnce(failingRun(adapter));
    const runtime = await factory()(new AbortController().signal, workspace);
    const protectedAdapter = runtime.redactAdapter(
      runtime.createAdapter({
        signal: new AbortController().signal,
        requestContext: undefined,
      }),
    );
    const task = defineTask({
      id: "codex-redaction-test",
      input: z.unknown(),
      output: z.unknown(),
      execute: async () => undefined,
    });

    await expect(runtime.modelCapabilities?.listModels()).rejects.toThrow(
      "model list failed for [REDACTED]",
    );
    await expect(
      runtime.modelCapabilities?.resolveDefaultModel(),
    ).rejects.toThrow("default model failed for [REDACTED]");
    await expect(
      protectedAdapter.execute({
        invocationId: "codex-redaction-test",
        observability: {},
        task,
        input: null,
        signal: new AbortController().signal,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      }),
    ).rejects.toThrow("execution failed in [REDACTED]");
    expect(diagnostics).toEqual(["diagnostic from [REDACTED]"]);
    await expect(protectedAdapter.captureCheckpoint?.()).rejects.toThrow(
      "checkpoint failed in [REDACTED]",
    );
    await expect(
      protectedAdapter.fork?.({ checkpoint: "checkpoint" }),
    ).rejects.toThrow("fork failed for [REDACTED]");
    await expect(protectedAdapter.sessionUi?.()).rejects.toThrow(
      "session UI failed in [REDACTED]",
    );
    await expect(protectedAdapter.close?.()).rejects.toThrow(
      "adapter close failed for [REDACTED]",
    );
    await expect(runtime.close?.()).rejects.toThrow(
      "close failed for [REDACTED]",
    );
  });
});
