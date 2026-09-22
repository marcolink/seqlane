import {
  createFlow,
  defineShellTask,
  defineTask,
  shellTaskResultSchema,
} from "@seqlane/core";
import { z } from "zod";
import {
  exactSearchArguments,
  readContextInputSchema,
  readContextRetrievalSchema,
  retrieveEvidenceFromScrapes,
  ripwireSearchArguments,
  zvecSearchArguments,
} from "../src/index.js";

const runAvailable = (command: string, args: readonly string[]): string[] => [
  "-c",
  `if command -v ${command} >/dev/null 2>&1; then exec ${command} "$@"; fi; exit 127`,
  `read-context-${command}`,
  ...args,
];

const scrapeFailure = (cause: unknown) => ({
  exitCode: 1,
  stdout: "",
  stderr:
    cause instanceof Error ? cause.message.slice(0, 1_000) : "scrape failed",
});

const exactSearchTask = defineShellTask({
  id: "read-context-exact-search",
  input: readContextInputSchema,
  executable: "sh",
  argv: (input) => runAvailable("rg", exactSearchArguments(input, ".")),
  timeoutMs: 5_000,
  onError: scrapeFailure,
});

const zvecSearchTask = defineShellTask({
  id: "read-context-zvec-search",
  input: readContextInputSchema,
  executable: "sh",
  argv: (input) => runAvailable("zg", zvecSearchArguments(input)),
  timeoutMs: 5_000,
  onError: scrapeFailure,
});

const ripwireSearchTask = defineShellTask({
  id: "read-context-ripwire-search",
  input: readContextInputSchema,
  executable: "sh",
  argv: (input) => runAvailable("ripwire", ripwireSearchArguments(input, ".")),
  timeoutMs: 10_000,
  onError: scrapeFailure,
});

const scrapeInputSchema = z.object({
  request: readContextInputSchema,
  exact: shellTaskResultSchema,
  zvec: shellTaskResultSchema,
  ripwire: shellTaskResultSchema,
});

const selectEvidenceTask = defineTask({
  id: "read-context-select-evidence",
  input: scrapeInputSchema,
  output: readContextRetrievalSchema,
  execute: async ({ input }) =>
    retrieveEvidenceFromScrapes(input.request, {
      exact: input.exact,
      zvec: input.zvec,
      ripwire: input.ripwire,
    }),
});

export const readContextRetrievalWorkflow = createFlow({
  id: "read-context-retrieve",
  input: readContextInputSchema,
  output: readContextRetrievalSchema,
})
  .task("exactSearch", exactSearchTask, ({ input }) => input, {
    workspace: "shared",
  })
  .task("zvecSearch", zvecSearchTask, ({ input }) => input, {
    workspace: "shared",
  })
  .task("ripwireSearch", ripwireSearchTask, ({ input }) => input, {
    workspace: "shared",
  })
  .task(
    "select",
    selectEvidenceTask,
    ({ input, tasks }) => ({
      request: input,
      exact: tasks.exactSearch.output,
      zvec: tasks.zvecSearch.output,
      ripwire: tasks.ripwireSearch.output,
    }),
    { workspace: "shared" },
  )
  .output(({ tasks }) => tasks.select.output)
  .define();

export default readContextRetrievalWorkflow;
