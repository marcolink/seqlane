import {
  createEffectTracerRunProgram,
  startRunnerProcess,
} from "@seqlane/runtime/runner";
import { createAcpAgentRuntimeFactory } from "@seqlane/acp-adapter";
import type { AgentRuntimeFactory } from "@seqlane/agent-adapter";
import { z } from "zod";

const environmentSchema = z.strictObject({
  mode: z.enum([
    "success",
    "hold",
    "permission",
    "missing-model",
    "invalid-first",
  ]),
  trace: z.string().min(1),
  server: z.string().min(1),
  persist: z.enum(["true", "false"]).transform((value) => value === "true"),
});

const createAgentRuntimeFactory = (): AgentRuntimeFactory => {
  const environment = environmentSchema.parse({
    mode: process.env.SEQLANE_ACP_FIXTURE_MODE,
    trace: process.env.SEQLANE_ACP_FIXTURE_TRACE,
    server: process.env.SEQLANE_ACP_FIXTURE_SERVER,
    persist: process.env.SEQLANE_ACP_FIXTURE_PERSIST,
  });
  return async (signal, workspace) => {
    const cwd = z.string().min(1).parse(workspace);
    const factory = createAcpAgentRuntimeFactory({
      adapter: "acp",
      configuration: {
        id: "compiled-cli-acp-fixture",
        description: "Controlled ACP v1 fixture",
        command: process.execPath,
        args: [environment.server],
        env: {
          SEQLANE_ACP_FIXTURE_MODE: environment.mode,
          SEQLANE_ACP_FIXTURE_TRACE: environment.trace,
          SEQLANE_ACP_FIXTURE_PERSIST: String(environment.persist),
        },
        cwd,
        persistSession: environment.persist,
        model: "fixture-model",
      },
    });
    return factory(signal, cwd);
  };
};

startRunnerProcess({
  workerEntrypoint: true,
  createRunProgram: createEffectTracerRunProgram,
  createAgentRuntimeFactory,
});
