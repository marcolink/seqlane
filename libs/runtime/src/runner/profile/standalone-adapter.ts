import type { RuntimeAdapterConfiguration } from "./runtime-adapter.js";

export class StandaloneAdapterSelectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "StandaloneAdapterSelectionError";
  }
}

export interface StandaloneAdapterConnection {
  readonly configuration: RuntimeAdapterConfiguration;
}

export interface StandaloneAdapterService {
  readonly configuration: RuntimeAdapterConfiguration;
  close(): Promise<void>;
}

export interface StandaloneAdapterLease {
  /** Starts the selected native adapter only when an agent invocation needs it. */
  acquire(): Promise<StandaloneAdapterConnection>;
  /** Releases only service resources created by this lease. */
  close(): Promise<void>;
}

export interface StandaloneAdapterLeaseOptions {
  readonly adapter?: string;
  readonly workspace: string;
  /** Run-wide cancellation; task attempts must not own this shared service. */
  readonly signal: AbortSignal;
  /** Composition-root factory for a registry-selected native adapter service. */
  readonly startAdapter?: (options: {
    readonly adapter: string;
    readonly workspace: string;
    readonly signal: AbortSignal;
  }) => Promise<StandaloneAdapterService>;
}

/** Creates a run-scoped, demand-driven native adapter service lease. */
export function createStandaloneAdapterLease(
  options: StandaloneAdapterLeaseOptions,
): StandaloneAdapterLease {
  const startAdapter = options.startAdapter;

  let service: Promise<StandaloneAdapterService> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const startupController = new AbortController();
  const startupSignal = AbortSignal.any([
    options.signal,
    startupController.signal,
  ]);

  function onAbort(): void {
    void close().catch(() => undefined);
  }

  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closed = true;
    options.signal.removeEventListener("abort", onAbort);
    startupController.abort();
    closing = (async () => {
      const started = await service?.catch(() => undefined);
      await started?.close();
    })();
    return closing;
  };
  const acquire = async (): Promise<StandaloneAdapterConnection> => {
    if (closed || options.signal.aborted) {
      await close();
      throw new StandaloneAdapterSelectionError(
        "Standalone adapter resources are already closed",
      );
    }
    if (options.adapter === undefined) {
      throw new StandaloneAdapterSelectionError(
        "Agent task requires --adapter <id>",
      );
    }
    if (startAdapter === undefined) {
      throw new StandaloneAdapterSelectionError(
        "No standalone adapter service factory is configured",
      );
    }
    const pending =
      service ??
      startAdapter({
        adapter: options.adapter,
        workspace: options.workspace,
        signal: startupSignal,
      });
    service ??= pending;
    let started: StandaloneAdapterService;
    try {
      started = await pending;
    } catch (cause) {
      if (service === pending && !closed) service = undefined;
      throw cause;
    }
    if (closed || options.signal.aborted) {
      await close();
      throw new StandaloneAdapterSelectionError(
        "Standalone adapter resources are already closed",
      );
    }
    return { configuration: started.configuration };
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();

  return { acquire, close };
}
