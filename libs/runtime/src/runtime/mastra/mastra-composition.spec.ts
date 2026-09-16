// @test-scope ./mastra-composition.ts

import { SpanType } from "@mastra/core/observability";
import {
  MastraPlatformExporter,
  MastraStorageExporter,
} from "@mastra/observability";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import {
  createAcpAdapter,
  parseAcpLaunchConfiguration,
} from "@seqlane/acp-adapter";
import { createOpenCodeAdapterForRun } from "@seqlane/opencode-adapter/testing";
import type { AgentTaskRequest, TaskDefinition } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMastraComposition } from "./mastra-composition.js";

const task: TaskDefinition = {
  id: "storage-observability-task",
  input: z.object({ value: z.string() }),
  output: z.object({ value: z.string() }),
  execute: async () => ({ value: "done" }),
};
const agent: AgentTaskRequest = {
  goal: "Process demo",
  instructions: ["Keep the change small"],
};

function request(
  observability: AgentAdapterRequest["observability"],
): AgentAdapterRequest {
  return {
    invocationId: "storage-invocation",
    observability,
    task,
    agent,
    input: { value: "demo" },
    signal: new AbortController().signal,
  };
}

describe("Mastra composition observability", () => {
  it("persists adapter-produced OpenCode and ACP tool spans through local storage", async () => {
    const composition = createMastraComposition([]);
    try {
      const instance = composition.observability.getDefaultInstance();
      expect(instance).toBeDefined();
      const exporters = instance?.getExporters() ?? [];
      expect(exporters).toHaveLength(2);
      expect(exporters[0]).toBeInstanceOf(MastraStorageExporter);
      expect(exporters[1]).toBeInstanceOf(MastraPlatformExporter);

      const openCodeRoot = instance?.startSpan({
        type: SpanType.WORKFLOW_STEP,
        name: "opencode-storage-verification",
      });
      const acpRoot = instance?.startSpan({
        type: SpanType.WORKFLOW_STEP,
        name: "acp-storage-verification",
      });
      expect(openCodeRoot).toBeDefined();
      expect(acpRoot).toBeDefined();

      const openCodeRun = {
        prompt: async ({ onObservation }) => {
          onObservation?.({
            kind: "tool",
            sessionID: "opencode-session",
            messageID: "opencode-message",
            callID: "opencode-call",
            tool: "ｅｃｈｏ",
            status: "completed",
            input: { secret: "opencode-input" },
            output: "opencode-output",
            metadata: { transcript: "opencode-transcript" },
          });
          return { structured: { value: "done" } };
        },
        checkpoint: async () => ({
          sessionId: "opencode-session",
          messageId: "opencode-message",
        }),
        fork: async () => {
          throw new Error("fork is not used by storage verification");
        },
        abort: async () => undefined,
        close: async () => undefined,
      } satisfies Parameters<typeof createOpenCodeAdapterForRun>[0];

      const openCodeAdapter = createOpenCodeAdapterForRun(openCodeRun);
      await expect(
        openCodeAdapter.execute(
          request({ tracingContext: { currentSpan: openCodeRoot } }),
        ),
      ).resolves.toEqual({ value: "done" });

      const acpAdapter = createAcpAdapter(
        parseAcpLaunchConfiguration({
          id: "storage-agent",
          description: "Storage verification agent",
          command: "storage-agent",
          persistSession: false,
        }),
        {
          createAgent: () => ({
            stream: async () => ({
              fullStream: new ReadableStream({
                start(controller) {
                  controller.enqueue({
                    type: "tool-call",
                    payload: {
                      toolCallId: "acp-call",
                      toolName: "read_file",
                      args: { secret: "acp-input" },
                    },
                  });
                  controller.enqueue({
                    type: "tool-result",
                    payload: {
                      toolCallId: "acp-call",
                      toolName: "read_file",
                      result: "acp-output",
                    },
                  });
                  controller.close();
                },
              }),
              text: Promise.resolve('{"value":"done"}'),
            }),
          }),
        },
      );
      await expect(
        acpAdapter.execute(
          request({ tracingContext: { currentSpan: acpRoot } }),
        ),
      ).resolves.toEqual({ value: "done" });

      openCodeRoot?.end();
      acpRoot?.end();
      await composition.observability.flush();

      const openCodeTrace = await composition.observability.getRecordedTrace({
        traceId: openCodeRoot?.traceId ?? "",
      });
      const acpTrace = await composition.observability.getRecordedTrace({
        traceId: acpRoot?.traceId ?? "",
      });
      const openCodeSpans = openCodeTrace?.spans ?? [];
      const acpSpans = acpTrace?.spans ?? [];
      const openCodeRootSpan = openCodeSpans.find(
        (span) => span.type === SpanType.WORKFLOW_STEP,
      );
      const openCodeAgent = openCodeSpans.find(
        (span) => span.type === SpanType.AGENT_RUN,
      );
      const openCodeTool = openCodeSpans.find(
        (span) => span.type === SpanType.TOOL_CALL,
      );
      const acpRootSpan = acpSpans.find(
        (span) => span.type === SpanType.WORKFLOW_STEP,
      );
      const acpAgent = acpSpans.find(
        (span) => span.type === SpanType.AGENT_RUN,
      );
      const acpTool = acpSpans.find((span) => span.type === SpanType.TOOL_CALL);

      expect(openCodeTool).toBeDefined();
      expect(openCodeTool?.parent).toBe(openCodeAgent);
      expect(openCodeAgent?.parent).toBe(openCodeRootSpan);
      expect(openCodeTool?.name).toBe("echo");
      expect(openCodeTool?.attributes).toMatchObject({
        toolType: "tool",
        toolCallId: "opencode-call",
        success: true,
      });
      expect(openCodeAgent?.metadata).toMatchObject({
        "seqlane.invocationId": "storage-invocation",
        "seqlane.adapter": "opencode",
      });

      expect(acpTool).toBeDefined();
      expect(acpTool?.parent).toBe(acpAgent);
      expect(acpAgent?.parent).toBe(acpRootSpan);
      expect(acpTool?.name).toBe("read_file");
      expect(acpTool?.attributes).toMatchObject({
        toolType: "tool",
        toolCallId: "acp-call",
        success: true,
      });
      expect(acpAgent?.metadata).toMatchObject({
        "seqlane.invocationId": "storage-invocation",
        "seqlane.adapter": "acp-v1",
      });

      const serialized = JSON.stringify(
        [...openCodeSpans, ...acpSpans].map((span) => ({
          type: span.type,
          name: span.name,
          attributes: span.attributes,
          metadata: span.metadata,
        })),
      );
      expect(serialized).not.toContain("opencode-input");
      expect(serialized).not.toContain("opencode-output");
      expect(serialized).not.toContain("opencode-transcript");
      expect(serialized).not.toContain("acp-input");
      expect(serialized).not.toContain("acp-output");
    } finally {
      await composition.shutdown();
    }
  });
});
