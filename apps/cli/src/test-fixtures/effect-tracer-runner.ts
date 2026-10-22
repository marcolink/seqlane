import { startRunnerProcess } from "@seqlane/runtime/runner";
import { createRunnerProcessOptions } from "../runner.js";

const captured = createRunnerProcessOptions(process.env);
startRunnerProcess({
  ...captured,
  workerEntrypoint: true,
  createAgentRuntimeFactory: () => {
    throw new Error(
      "Effect tracer fixture must not construct an agent runtime",
    );
  },
});
