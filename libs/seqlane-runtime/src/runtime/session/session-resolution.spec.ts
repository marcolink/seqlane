// @test-scope ./session-resolution.ts
import type { ModelSelection, TaskDefinition } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  publishSessionCheckpoint,
  resolveTaskSession,
  type ResolvedExecutorSession,
  type SessionResolver,
} from "./session-resolution.js";

const taskDefinition: TaskDefinition = {
  id: "task",
  input: z.unknown(),
  output: z.unknown(),
  execute: async ({ context }) => context.runAgent({ goal: "task" }),
};

const requestedSelection: ModelSelection = {
  model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  reasoning: "high",
};

const returnedSelection: ModelSelection = {
  model: { provider: "openai", model: "gpt-5.6-sol" },
  reasoning: "medium",
};

const executor = { execute: async () => ({}) };

describe("session model selection resolution", () => {
  it("rejects an adapter session with a different effective selection", async () => {
    const resolvedSessions = new Map<string, ResolvedExecutorSession>();
    const session: ResolvedExecutorSession = {
      key: Symbol("adapter-session"),
      executor,
      effectiveSelection: returnedSelection,
    };
    const resolver: SessionResolver = {
      resolve: async () => session,
    };

    await expect(
      resolveTaskSession(
        resolvedSessions,
        resolver,
        new Map([[taskDefinition.id, taskDefinition]]),
        "invocation",
        taskDefinition.id,
        requestedSelection,
      ),
    ).rejects.toThrow(/effective model selection/i);
    expect(resolvedSessions).toEqual(new Map());
  });

  it("rejects a fork session with a different effective selection", async () => {
    const resolvedSessions = new Map<string, ResolvedExecutorSession>();
    const sourceSession: ResolvedExecutorSession = {
      key: Symbol("source-session"),
      executor,
      effectiveSelection: returnedSelection,
      checkpoint: async () => "checkpoint",
      fork: async () => ({
        key: Symbol("fork-session"),
        executor,
        effectiveSelection: returnedSelection,
      }),
    };

    await expect(
      publishSessionCheckpoint({
        sourceNodeId: "source",
        sourceSession,
        consumers: [
          {
            invocationId: "branch",
            task: taskDefinition,
            type: "branch",
            effectiveSelection: requestedSelection,
          },
        ],
        resolvedSessions,
      }),
    ).rejects.toThrow(/effective model selection/i);
    expect(resolvedSessions).toEqual(new Map());
  });
});
