// @test-scope ./mastra-choice-compiler.ts

import { choiceNodeSchema } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { branchWorkflow } from "./mastra-choice-compiler.js";
import type { MastraPlanInvocationContext } from "./mastra-plan-compiler.js";
import { createMastraRuntime } from "../mastra/mastra-runtime.js";

const node = choiceNodeSchema.parse({
  type: "choice",
  nodeId: "choice:1",
  condition: { type: "ref", nodeId: "__seqlane_input", path: ["condition"] },
  then: {
    type: "task",
    nodeId: "choice:1:then",
    taskId: "then",
    workspace: "shared",
    input: { type: "ref", nodeId: "source", path: ["output"] },
    dependsOn: ["source"],
  },
  else: {
    type: "task",
    nodeId: "choice:1:else",
    taskId: "else",
    workspace: "shared",
    input: { type: "ref", nodeId: "source", path: ["output"] },
    dependsOn: ["source"],
  },
  dependsOn: ["source"],
});

describe("choice envelope integration boundary", () => {
  it.each([true, false])(
    "reuses the parsed envelope for condition %s",
    async (condition) => {
      const payload = { content: "large result".repeat(10000) };
      const source = { output: payload };
      const results = { source };
      const executeInvocation = vi.fn(
        async (context: MastraPlanInvocationContext) => {
          expect(context.input).toBe(payload);
          expect(context.getStepResult("source")).toBe(source);
          return payload;
        },
      );
      const workflow = branchWorkflow(
        node,
        { executeInvocation },
        {
          schemaForNodeInput: () => undefined,
          invocationIdForNode: (id) => id,
          reportFailure: () => {
            throw new Error("Unexpected input failure");
          },
        },
        new Map(),
      );
      let parsedEnvelope: unknown;
      const entry = workflow.steps[`${node.nodeId}:condition`];
      if (entry === undefined) throw new Error("Missing choice entry step");
      const executeEntry = entry.execute;
      vi.spyOn(entry, "execute").mockImplementation(async (context) => {
        parsedEnvelope = await executeEntry(context);
        return parsedEnvelope;
      });
      const selected =
        workflow.steps[condition ? node.then.nodeId : node.else.nodeId];
      if (selected === undefined) throw new Error("Missing selected arm step");
      const executeSelected = selected.execute;
      vi.spyOn(selected, "execute").mockImplementation(async (context) => {
        // A second schema parse would copy the envelope and dependency record.
        expect(context.inputData).toBe(parsedEnvelope);
        return executeSelected(context);
      });
      const runtime = createMastraRuntime([{ key: "choice", workflow }], {
        exposeServer: false,
      });
      try {
        await expect(
          runtime.run({
            workflowKey: "choice",
            input: {
              condition,
              workflowInput: { condition },
              results,
              workId: "work",
              runId: "run",
            },
            workId: "work",
            runId: "run",
          }),
        ).resolves.toEqual({ status: "succeeded", result: payload });
        expect(executeInvocation).toHaveBeenCalledOnce();
        expect(executeInvocation.mock.calls[0]?.[0].node.nodeId).toBe(
          condition ? node.then.nodeId : node.else.nodeId,
        );
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it.each([
    { condition: "yes", results: {} },
    { condition: true, results: [] },
    { condition: true, results: null },
    { condition: true, results: {}, workId: 123 },
  ])(
    "rejects a malformed envelope %j before executing an arm",
    async (invalid) => {
      const executeInvocation = vi.fn();
      const workflow = branchWorkflow(
        node,
        { executeInvocation },
        {
          schemaForNodeInput: () => undefined,
          invocationIdForNode: (id) => id,
          reportFailure: () => {
            throw new Error("Unexpected arm input failure");
          },
        },
        new Map(),
      );
      const runtime = createMastraRuntime([{ key: "choice", workflow }], {
        exposeServer: false,
      });
      try {
        await expect(
          runtime.run({
            workflowKey: "choice",
            input: {
              workflowInput: {},
              workId: "work",
              runId: "run",
              ...invalid,
            },
            workId: "work",
            runId: "run",
          }),
        ).resolves.toMatchObject({ status: "failed" });
        expect(executeInvocation).not.toHaveBeenCalled();
      } finally {
        await runtime.shutdown();
      }
    },
  );
});
