import { z } from "zod";

export type StructuredOutputStrategy = "auto" | "native" | "prompt";

export interface StructuredOutputConfiguration {
  readonly strategy?: StructuredOutputStrategy;
  readonly retryCount?: number;
  readonly onDiagnostic?: (diagnostic: StructuredOutputDiagnostic) => void;
}

export interface StructuredOutputDiagnostic {
  readonly type:
    | "strategy-selected"
    | "native-readback-incompatible"
    | "attempt"
    | "completed";
  readonly strategy: "native" | "prompt";
  readonly reason?:
    | "explicit"
    | "known-good-version"
    | "affected-version"
    | "unknown-version"
    | "runtime-downgrade";
  readonly version?: string;
  readonly attempt?: number;
  readonly success?: boolean;
}

export interface ResolvedStructuredOutput {
  readonly strategy: "native" | "prompt";
  readonly retryCount: number;
  readonly version?: string;
  readonly report: (diagnostic: {
    readonly type: "attempt" | "completed";
    readonly attempt?: number;
    readonly success?: boolean;
  }) => void;
}

const configurationSchema = z.object({
  strategy: z.enum(["auto", "native", "prompt"]).default("auto"),
  retryCount: z.number().int().nonnegative().default(2),
});

const knownGoodVersions = new Set(["1.14.19"]);
const affectedVersions = new Set(["1.14.48", "1.17.13", "1.18.27"]);

export function normalizeStructuredOutputConfiguration(
  configuration: StructuredOutputConfiguration | undefined,
): Required<Pick<StructuredOutputConfiguration, "strategy" | "retryCount">> &
  Pick<StructuredOutputConfiguration, "onDiagnostic"> {
  const parsed = configurationSchema.parse(configuration ?? {});
  return {
    ...parsed,
    ...(configuration?.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: configuration.onDiagnostic }),
  };
}

export function resolveStructuredOutputStrategy(
  strategy: StructuredOutputStrategy,
  version: string | undefined,
  downgraded: boolean,
): {
  readonly strategy: "native" | "prompt";
  readonly reason: StructuredOutputDiagnostic["reason"];
} {
  if (strategy === "native" || strategy === "prompt") {
    return { strategy, reason: "explicit" };
  }
  if (downgraded) return { strategy: "prompt", reason: "runtime-downgrade" };
  if (version !== undefined && knownGoodVersions.has(version)) {
    return { strategy: "native", reason: "known-good-version" };
  }
  if (version !== undefined && affectedVersions.has(version)) {
    return { strategy: "prompt", reason: "affected-version" };
  }
  return { strategy: "prompt", reason: "unknown-version" };
}

export function createStructuredOutputState(options: {
  readonly configuration?: StructuredOutputConfiguration;
  readonly resolveVersion: () => Promise<string | undefined>;
}): StructuredOutputState {
  const configuration = normalizeStructuredOutputConfiguration(
    options.configuration,
  );
  let versionPromise: Promise<string | undefined> | undefined;
  let downgraded = false;

  return {
    async resolve() {
      const version =
        configuration.strategy === "auto"
          ? await (versionPromise ??= options.resolveVersion())
          : undefined;
      const selected = resolveStructuredOutputStrategy(
        configuration.strategy,
        version,
        downgraded,
      );
      configuration.onDiagnostic?.({
        type: "strategy-selected",
        strategy: selected.strategy,
        reason: selected.reason,
        ...(version === undefined ? {} : { version }),
      });
      return {
        strategy: selected.strategy,
        retryCount: configuration.retryCount,
        ...(version === undefined ? {} : { version }),
        report: (diagnostic) =>
          configuration.onDiagnostic?.({
            ...diagnostic,
            strategy: selected.strategy,
            ...(version === undefined ? {} : { version }),
          }),
      };
    },
    markNativeReadbackIncompatible(version) {
      downgraded = true;
      configuration.onDiagnostic?.({
        type: "native-readback-incompatible",
        strategy: "native",
        ...(version === undefined ? {} : { version }),
      });
    },
  };
}

export interface StructuredOutputState {
  readonly resolve: () => Promise<ResolvedStructuredOutput>;
  readonly markNativeReadbackIncompatible: (version?: string) => void;
}
