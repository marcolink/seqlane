import {
  createFlow,
  defineAgentTask,
  fork,
  isolated,
  reuse,
} from "@seqlane/core";
import { z } from "zod";

const input = z.strictObject({ value: z.string() });
const output = z.strictObject({
  done: z.boolean(),
  count: z.number(),
  text: z.string(),
  items: z.array(z.string()),
});

function task(id: string) {
  return defineAgentTask({
    id,
    input,
    output,
    goal: ({ value }) => `Return the fixture result for ${value}`,
  });
}

const source = task("effect-acp-source");
const reused = task("effect-acp-reused");
const forked = task("effect-acp-forked");

export const effectAcpReuseWorkflow = createFlow({
  id: "effect-acp-reuse-cli-fixture",
  input,
  output,
})
  .task("source", source, ({ input }) => input, {
    session: isolated(),
  })
  .task("reused", reused, ({ input }) => input, {
    session: ({ tasks }) => reuse(tasks.source.session),
  })
  .output(({ tasks }) => tasks.reused.output)
  .define();

export const effectAcpForkWorkflow = createFlow({
  id: "effect-acp-fork-cli-fixture",
  input,
  output,
})
  .task("source", source, ({ input }) => input, {
    session: isolated(),
  })
  .task("forked", forked, ({ input }) => input, {
    session: ({ tasks }) => fork(tasks.source.session),
  })
  .output(({ tasks }) => tasks.forked.output)
  .define();

export const effectAcpUnsupportedModelWorkflow = createFlow({
  id: "effect-acp-unsupported-model-cli-fixture",
  input,
  output,
})
  .task("source", task("effect-acp-unsupported-model"), ({ input }) => input, {
    session: isolated(),
  })
  .output(({ tasks }) => tasks.source.output)
  .define();

export const effectAcpSingleWorkflow = createFlow({
  id: "effect-acp-single-cli-fixture",
  input,
  output,
})
  .task("single", task("effect-acp-single"), ({ input }) => input, {
    session: isolated(),
  })
  .output(({ tasks }) => tasks.single.output)
  .define();
