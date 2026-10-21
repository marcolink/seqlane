import {
  createEffectTracerRunProgram,
  startRunnerProcess,
} from "@seqlane/runtime/runner";

startRunnerProcess({
  workerEntrypoint: true,
  createAgentRuntimeFactory: () => {
    throw new Error(
      "Effect tracer fixture must not construct an agent runtime",
    );
  },
  createRunProgram: createEffectTracerRunProgram,
});
