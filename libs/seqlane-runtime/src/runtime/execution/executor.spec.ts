import type { TaskDefinition, SeqlaneSchema } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  getExecutor,
  type ExecutorResolvers,
  type SeqlaneExecutor,
} from "./executor.js";

const schema = <T>(): SeqlaneSchema<T> => z.custom<T>();

function executor(result: unknown): SeqlaneExecutor {
  return { execute: async () => result };
}

describe("private executor resolution", () => {
  it("resolves agent work without reading a Plan executor field", () => {
    const task: TaskDefinition<{ value: string }, string> = {
      id: "agent-task",
      input: schema<{ value: string }>(),
      output: schema<string>(),
      execute: async ({ input, context }) =>
        (await context.runAgent({ goal: input.value })) as string,
    };
    const resolved = executor("agent-result");
    const resolvers: ExecutorResolvers = {
      agent: (receivedTask) => {
        expect(receivedTask).toBe(task);
        return resolved;
      },
    };

    expect(
      getExecutor(
        resolvers,
        {
          type: "task",
          taskId: "agent-task",
          nodeId: "agent-task:1",
          workspace: "shared",
          input: {},
          dependsOn: [],
        },
        task,
      ),
    ).toBe(resolved);
  });
});
