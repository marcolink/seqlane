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

export function assertStandaloneAdapter(adapter: string | undefined): void {
  if (adapter !== undefined && adapter !== "opencode") {
    throw new Error(
      `Unknown adapter "${adapter}"; supported adapters: opencode`,
    );
  }
}

/** Starts the selected native adapter and exposes only the runtime binding. */
export async function startStandaloneAdapter(options: {
  readonly adapter: string;
  readonly workspace: string;
  readonly signal: AbortSignal;
}): Promise<StandaloneAdapterService<StandaloneAdapterBinding>> {
  assertStandaloneAdapter(options.adapter);
  if (options.adapter === undefined) throw new Error("Adapter is required");
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
        service.authorization,
      ),
      createAdapter: (selection) =>
        createOpenCodeAdapter(
          {
            url: service.url,
            authorization: service.authorization,
            workspace: options.workspace,
          },
          { signal: options.signal, modelSelection: selection },
        ),
    },
    close: () => service.close(),
  };
}
