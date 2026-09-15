import { RequestContext } from "@mastra/core/request-context";

interface OperationalRunLike {
  readonly runId: string;
  readonly resourceId?: string;
  readonly start: (options: Record<string, unknown>) => Promise<unknown>;
  readonly startAsync: (options: Record<string, unknown>) => Promise<unknown>;
  readonly resume: (options: Record<string, unknown>) => Promise<unknown>;
  readonly resumeAsync: (options: Record<string, unknown>) => Promise<unknown>;
  readonly cancel: () => Promise<void>;
  readonly watch?: (
    callback: (event: { readonly type: string }) => void,
  ) => () => void;
}

interface OperationalWorkflowLike {
  readonly createRun: (
    options?: Record<string, unknown>,
  ) => Promise<OperationalRunLike>;
}

type PrepareRunContext = (
  requestContext: RequestContext,
  workId: string,
  runId: string,
) => void;

type RunMethod = "start" | "startAsync" | "resume" | "resumeAsync";

interface OperationalRunLifecycle {
  readonly run: OperationalRunLike;
  readonly workId: string;
  readonly runId: string;
  readonly prepareRunContext: PrepareRunContext;
  readonly cleanup: () => Promise<void>;
}

export function instrumentOperationalWorkflow(
  workflow: unknown,
  prepareRunContext: PrepareRunContext,
  terminate: (runId: string) => Promise<void>,
): unknown {
  const target = workflow as OperationalWorkflowLike;
  if (typeof target.createRun !== "function") return workflow;

  return new Proxy(target, {
    get(object, property) {
      if (property === "createRun") {
        return async (options: Record<string, unknown> = {}) => {
          const run = await object.createRun(options);
          return instrumentOperationalRun(
            run,
            options,
            prepareRunContext,
            terminate,
          );
        };
      }
      return bindProperty(object, property);
    },
  });
}

function instrumentOperationalRun(
  run: OperationalRunLike,
  options: Record<string, unknown>,
  prepareRunContext: PrepareRunContext,
  terminate: (runId: string) => Promise<void>,
): OperationalRunLike {
  const runId = run.runId;
  const workId = resolveWorkId(run, options);
  let cleanupPromise: Promise<void> | undefined;
  const watchState: { unwatch?: () => void } = {};
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      watchState.unwatch?.();
      await terminate(runId);
    })();
    return cleanupPromise;
  };

  watchState.unwatch = run.watch?.((event) => {
    if (
      event.type === "workflow-finish" ||
      event.type === "workflow-canceled"
    ) {
      void cleanup().catch(() => undefined);
    }
  });
  const lifecycle: OperationalRunLifecycle = {
    run,
    workId,
    runId,
    prepareRunContext,
    cleanup,
  };

  return new Proxy(run, {
    get(runObject, property) {
      if (property === "cancel") {
        return async (): Promise<void> => {
          try {
            await runObject.cancel();
          } finally {
            await cleanup().catch(() => undefined);
          }
        };
      }
      if (isRunMethod(property)) {
        return (startOptions: Record<string, unknown> = {}) =>
          invokeRunMethod(lifecycle, property, startOptions);
      }
      return bindProperty(runObject, property);
    },
  });
}

async function invokeRunMethod(
  lifecycle: OperationalRunLifecycle,
  method: RunMethod,
  options: Record<string, unknown>,
): Promise<unknown> {
  const requestContext =
    options.requestContext instanceof RequestContext
      ? options.requestContext
      : new RequestContext();
  lifecycle.prepareRunContext(
    requestContext,
    lifecycle.workId,
    lifecycle.runId,
  );
  try {
    return await Reflect.apply(lifecycle.run[method], lifecycle.run, [
      { ...options, requestContext },
    ]);
  } finally {
    if (!isAsyncRunMethod(method)) {
      await lifecycle.cleanup().catch(() => undefined);
    }
  }
}

function resolveWorkId(
  run: OperationalRunLike,
  options: Record<string, unknown>,
): string {
  return (
    run.resourceId ??
    (typeof options.resourceId === "string" ? options.resourceId : undefined) ??
    run.runId
  );
}

function isRunMethod(property: PropertyKey): property is RunMethod {
  return (
    property === "start" ||
    property === "startAsync" ||
    property === "resume" ||
    property === "resumeAsync"
  );
}

function isAsyncRunMethod(method: RunMethod): boolean {
  return method === "startAsync" || method === "resumeAsync";
}

function bindProperty(object: object, property: PropertyKey): unknown {
  const value = Reflect.get(object, property, object);
  return typeof value === "function" ? value.bind(object) : value;
}
