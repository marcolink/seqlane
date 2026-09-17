import type {
  StandaloneAdapterBinding,
  StandaloneAdapterService,
} from "@seqlane/runtime";
import {
  createOpenCodeAdapter,
  createOpenCodeModelCapabilities,
  startOpenCodeService,
} from "@seqlane/opencode-adapter";

const openCodeCapabilities = {
  execute: true,
  modelSelection: true,
  structuredOutput: true,
  sessionReuse: true,
  checkpoint: true,
  fork: true,
  activity: true,
  sessionUi: false,
} as const;

/** Starts the selected native adapter and exposes only the runtime binding. */
export async function startStandaloneAdapter(options: {
  readonly adapter: string;
  readonly workspace: string;
  readonly signal: AbortSignal;
}): Promise<StandaloneAdapterService<StandaloneAdapterBinding>> {
  if (options.adapter !== "opencode") {
    throw new Error(
      `Unknown adapter "${options.adapter}"; supported adapters: opencode`,
    );
  }
  const service = await startOpenCodeService({
    workspace: options.workspace,
    signal: options.signal,
  });
  return {
    binding: {
      capabilities: openCodeCapabilities,
      modelCapabilities: createOpenCodeModelCapabilities(
        service.url,
        options.workspace,
      ),
      createAdapter: (selection) =>
        createOpenCodeAdapter(
          { url: service.url, workspace: options.workspace },
          { signal: options.signal, modelSelection: selection },
        ),
    },
    close: () => service.close(),
  };
}
