import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore, type MastraCompositeStore } from "@mastra/core/storage";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { MastraStorageExporter, Observability } from "@mastra/observability";

export interface MastraWorkflowRegistration {
  readonly key: string;
  readonly workflow: AnyWorkflow;
}

export interface MastraComposition {
  readonly mastra: Mastra;
  readonly workflows: Readonly<Record<string, AnyWorkflow>>;
  readonly storage: MastraCompositeStore;
  readonly observability: Observability;
  shutdown(): Promise<void>;
}

const WORK_ID_CONTEXT_KEY = "seqlane.workId";
const RUN_ID_CONTEXT_KEY = "seqlane.runId";

export function createMastraComposition(
  registrations: readonly MastraWorkflowRegistration[],
  storage: MastraCompositeStore = new InMemoryStore({
    id: "seqlane-runtime-storage",
  }),
): MastraComposition {
  const keys = new Set<string>();
  for (const registration of registrations) {
    if (registration.key.length === 0) {
      throw new TypeError(
        "Mastra workflow registration keys must not be empty",
      );
    }
    if (keys.has(registration.key)) {
      throw new TypeError(
        `Mastra workflow registration key is duplicated: "${registration.key}"`,
      );
    }
    keys.add(registration.key);
  }
  const workflows: Record<string, AnyWorkflow> = Object.fromEntries(
    registrations.map(({ key, workflow }) => [key, workflow]),
  );
  const observability = new Observability({
    configs: {
      default: {
        serviceName: "seqlane-runtime",
        exporters: [new MastraStorageExporter()],
        requestContextKeys: [WORK_ID_CONTEXT_KEY, RUN_ID_CONTEXT_KEY],
      },
    },
  });
  const mastra = new Mastra({
    workflows,
    storage,
    observability,
    logger: false,
  });
  let shutdownPromise: Promise<void> | undefined;

  return {
    mastra,
    workflows,
    storage,
    observability,
    shutdown() {
      return (shutdownPromise ??= (async () => {
        await observability.flush();
        await mastra.shutdown();
      })());
    },
  };
}
