import {
  createFlow,
  defineAgentTask,
  defineTask,
  fork,
  isolated,
  reuse,
} from "@seqlane/core";
import { openai } from "@seqlane/core/models";
import { z } from "zod";

const input = z.strictObject({ value: z.string() });
const output = z.strictObject({
  done: z.boolean(),
  count: z.number(),
  text: z.string(),
  items: z.array(z.string()),
});

const nativeTask = (id: string) =>
  defineAgentTask({
    id,
    input,
    output,
    goal: ({ value }) => `Return the fixture result for ${value}`,
  });

const deterministicPreparation = defineTask({
  id: "native-mixed-preparation",
  input,
  output: input,
  execute: async ({ input: value }) => value,
});

export const effectNativeWorkflow = createFlow({
  id: "effect-native-cli-fixture",
  input,
  output,
})
  .task("source", nativeTask("native-source"), ({ input }) => input, {
    session: isolated(),
  })
  .task("reused", nativeTask("native-reused"), ({ input }) => input, {
    session: ({ tasks }) => reuse(tasks.source.session),
  })
  .task("forked", nativeTask("native-forked"), ({ input }) => input, {
    session: ({ tasks }) => fork(tasks.source.session),
  })
  .output(({ tasks }) => tasks.forked.output)
  .define();

export const effectNativeSingleWorkflow = createFlow({
  id: "effect-native-single-cli-fixture",
  input,
  output,
})
  .task("single", nativeTask("native-single"), ({ input }) => input)
  .output(({ tasks }) => tasks.single.output)
  .define();

export const effectNativeMixedWorkflow = createFlow({
  id: "effect-native-mixed-cli-fixture",
  input,
  output,
})
  .task("preparation", deterministicPreparation, ({ input: value }) => value)
  .task(
    "agent",
    nativeTask("native-mixed-agent"),
    ({ tasks }) => tasks.preparation.output,
  )
  .output(({ tasks }) => tasks.agent.output)
  .define();

export const effectNativeUnsupportedModelWorkflow = createFlow({
  id: "effect-native-unsupported-model-cli-fixture",
  input,
  output,
})
  .task("unsupported", nativeTask("native-unsupported"), ({ input }) => input, {
    session: isolated({ model: openai("gpt-5.6-luna") }),
  })
  .output(({ tasks }) => tasks.unsupported.output)
  .define();
