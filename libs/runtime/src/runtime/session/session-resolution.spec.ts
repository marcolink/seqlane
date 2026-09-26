// @test-scope ./session-resolution.ts
import type { ModelSelection, TaskDefinition } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  publishSessionCheckpoint,
  materializeDeferredSessionConsumer,
  type DeferredSessionSource,
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
  it("forks only the selected deferred choice consumer", async () => {
    const fork = vi.fn(async ({ invocationId }: { invocationId: string }) => ({
      key: Symbol(invocationId),
      executor,
    }));
    const sourceSession: ResolvedExecutorSession = {
      key: Symbol("source"),
      executor,
      checkpoint: async () => "source-state",
      fork,
    };
    const consumers = ["then", "else"].map((invocationId) => ({
      invocationId,
      task: taskDefinition,
      type: "branch" as const,
      deferred: true,
    }));
    const deferredSources = new Map<string, DeferredSessionSource>();
    const resolvedSessions = new Map<string, ResolvedExecutorSession>();
    await publishSessionCheckpoint({
      sourceNodeId: "source",
      sourceSession,
      consumers,
      resolvedSessions,
      deferredSources,
    });
    expect(fork).not.toHaveBeenCalled();
    expect(resolvedSessions.size).toBe(0);
    const selected = consumers[0];
    if (selected === undefined) throw new Error("Missing selected consumer");
    await materializeDeferredSessionConsumer({
      sourceNodeId: "source",
      source: deferredSources.get("source"),
      consumer: selected,
      resolvedSessions,
    });
    expect(fork).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        checkpoint: "source-state",
        invocationId: "then",
      }),
    );
    expect(resolvedSessions.has("then")).toBe(true);
    expect(resolvedSessions.has("else")).toBe(false);
  });

  it("defers a checkpoint error until its choice branch is selected", async () => {
    const failure = new Error("checkpoint unavailable");
    const sourceSession: ResolvedExecutorSession = {
      key: Symbol("source"),
      executor,
      checkpoint: async () => {
        throw failure;
      },
      fork: async () => ({ key: Symbol("branch"), executor }),
    };
    const consumer = {
      invocationId: "branch",
      task: taskDefinition,
      type: "branch" as const,
      deferred: true,
    };
    const deferredSources = new Map<string, DeferredSessionSource>();
    const resolvedSessions = new Map<string, ResolvedExecutorSession>();
    await expect(
      publishSessionCheckpoint({
        sourceNodeId: "source",
        sourceSession,
        consumers: [consumer],
        resolvedSessions,
        deferredSources,
      }),
    ).resolves.toBeUndefined();
    await expect(
      materializeDeferredSessionConsumer({
        sourceNodeId: "source",
        source: deferredSources.get("source"),
        consumer,
        resolvedSessions,
      }),
    ).rejects.toBe(failure);
  });

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
