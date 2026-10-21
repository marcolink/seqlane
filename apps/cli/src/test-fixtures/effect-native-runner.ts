import {
  createEffectTracerRunProgram,
  startRunnerProcess,
} from "@seqlane/runtime/runner";
import { createOpenCodeAgentRuntimeFactory } from "@seqlane/opencode-adapter";
import { createCodexAgentRuntimeFactory } from "@seqlane/codex-adapter";
import { z } from "zod";

const environmentSchema = z.discriminatedUnion("adapter", [
  z.object({ adapter: z.literal("opencode"), endpoint: z.url() }),
  z.object({ adapter: z.literal("codex"), endpoint: z.string().min(1) }),
]);

startRunnerProcess({
  workerEntrypoint: true,
  createRunProgram: createEffectTracerRunProgram,
  createAgentRuntimeFactory: () => {
    const configuration = environmentSchema.parse({
      adapter: process.env.SEQLANE_NATIVE_FIXTURE_ADAPTER,
      endpoint: process.env.SEQLANE_NATIVE_FIXTURE_ENDPOINT,
    });
    return configuration.adapter === "opencode"
      ? createOpenCodeAgentRuntimeFactory({
          adapter: "opencode",
          url: configuration.endpoint,
        })
      : createCodexAgentRuntimeFactory({
          adapter: "codex",
          executable: configuration.endpoint,
          networkAccess: false,
        });
  },
});
