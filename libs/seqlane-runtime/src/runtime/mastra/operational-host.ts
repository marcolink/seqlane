import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { serve as serveNode, type ServerType } from "@hono/node-server";
import { MastraServer } from "@mastra/hono";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import type {
  Plan,
  TaskDefinitionRegistry,
  ValidatorDefinitionRegistry,
} from "@seqlane/core";
import { Hono } from "hono";
import { compilePlanToMastra } from "../compile/mastra-plan-compiler.js";
import {
  createMastraComposition,
  type MastraWorkflowRegistration,
} from "./mastra-composition.js";

export interface OperationalWorkflowRegistration {
  readonly key: string;
  /** Mastra workflow values stay opaque at this boundary. */
  readonly workflow: unknown;
}

export interface OperationalWorkflowSource {
  readonly key: string;
  readonly plan: Plan;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
}

export interface OperationalHostOptions {
  readonly workflows: readonly OperationalWorkflowRegistration[];
  readonly storageUrl?: string;
  readonly host?: string;
  readonly port?: number;
}

export interface OperationalHost {
  readonly host: string;
  readonly port: number;
  readonly address: string;
  readonly ready: boolean;
  fetch(request: Request): Promise<Response>;
  listen(): Promise<string>;
  close(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4111;
const DEFAULT_STORAGE_URL = "file:./.seqlane/mastra.db";

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function validateOptions(options: OperationalHostOptions): void {
  if (options.workflows.length === 0) {
    throw new TypeError("At least one workflow must be registered");
  }
  if (options.host !== undefined && options.host.length === 0) {
    throw new TypeError("Operational host address must not be empty");
  }
  if (!isLoopbackHost(options.host ?? DEFAULT_HOST)) {
    throw new TypeError(
      "Operational host must bind to a loopback address (localhost, 127.0.0.1, or ::1)",
    );
  }
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535)
  ) {
    throw new TypeError(
      "Operational host port must be an integer from 0 to 65535",
    );
  }
  if (options.storageUrl !== undefined && options.storageUrl.length === 0) {
    throw new TypeError("Operational host storage URL must not be empty");
  }
}

function storageFromUrl(url: string): MastraCompositeStore {
  if (!url.startsWith("file:")) {
    return new LibSQLStore({ id: "seqlane-operational-storage", url });
  }

  const filePath = url.slice("file:".length);
  if (filePath.length === 0) {
    throw new TypeError(
      "Operational host file storage URL must include a path",
    );
  }
  if (filePath === ":memory:" || filePath.startsWith(":memory:?")) {
    return new LibSQLStore({ id: "seqlane-operational-storage", url });
  }

  const resolvedPath = isAbsolute(filePath)
    ? filePath
    : resolve(process.cwd(), filePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  return new LibSQLStore({
    id: "seqlane-operational-storage",
    url: `file:${resolvedPath}`,
  });
}

export function createOperationalWorkflow(
  source: OperationalWorkflowSource,
): OperationalWorkflowRegistration {
  const compiled = compilePlanToMastra(source.plan, {
    taskDefinitions: source.taskDefinitions,
    validatorDefinitions: source.validatorDefinitions,
  });
  return { key: source.key, workflow: compiled.workflow };
}

function asMastraRegistrations(
  registrations: readonly OperationalWorkflowRegistration[],
): readonly MastraWorkflowRegistration[] {
  return registrations.map((registration) => ({
    key: registration.key,
    // Mastra types are intentionally confined to this runtime integration edge.
    workflow: registration.workflow as never,
  }));
}

export async function createOperationalHost(
  options: OperationalHostOptions,
): Promise<OperationalHost> {
  validateOptions(options);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  let composition: ReturnType<typeof createMastraComposition> | undefined;

  try {
    const storage = storageFromUrl(options.storageUrl ?? DEFAULT_STORAGE_URL);
    composition = createMastraComposition(
      asMastraRegistrations(options.workflows),
      storage,
    );
    const app = new Hono();
    const adapter = new MastraServer({ app, mastra: composition.mastra });

    await storage.init();
    await adapter.init();
    let nodeServer: ServerType | undefined;
    let closed = false;
    let listeningPort = port;
    let ready = false;

    app.get("/healthz", (context) =>
      context.json({ status: "ok", service: "seqlane" }),
    );
    app.get("/readyz", (context) =>
      context.json(
        { status: ready ? "ready" : "starting", service: "seqlane" },
        ready ? 200 : 503,
      ),
    );

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      ready = false;
      try {
        await new Promise<void>((resolveClose, rejectClose) => {
          if (nodeServer === undefined) {
            resolveClose();
            return;
          }
          nodeServer.close((error) => {
            const closeError = error as (Error & { code?: string }) | undefined;
            if (
              closeError === undefined ||
              closeError.code === "ERR_SERVER_NOT_RUNNING"
            ) {
              resolveClose();
            } else rejectClose(closeError);
          });
        });
      } finally {
        await composition?.shutdown();
      }
    };

    const operationalHost: OperationalHost = {
      host,
      get port() {
        return listeningPort;
      },
      get address() {
        return `http://${host}:${listeningPort}`;
      },
      get ready() {
        return ready;
      },
      fetch: async (request) => app.fetch(request),
      listen: () => {
        if (closed) {
          return Promise.reject(new Error("Operational host is closed"));
        }
        if (ready) return Promise.resolve(operationalHost.address);

        return new Promise<string>((resolveListen, rejectListen) => {
          const onError = (error: Error & { code?: string }) => {
            nodeServer?.removeListener("error", onError);
            nodeServer = undefined;
            ready = false;
            rejectListen(error);
            void composition?.shutdown();
          };
          const onListening = () => {
            nodeServer?.removeListener("error", onError);
            const address = nodeServer?.address();
            if (address !== null && typeof address === "object") {
              listeningPort = address.port;
            }
            ready = true;
            resolveListen(operationalHost.address);
          };

          try {
            nodeServer = serveNode(
              {
                fetch: app.fetch,
                hostname: host,
                port,
              },
              onListening,
            );
            nodeServer.once("error", onError);
          } catch (cause) {
            rejectListen(cause);
          }
        });
      },
      close,
    };
    return operationalHost;
  } catch (cause) {
    await composition?.shutdown();
    throw new Error("Could not initialize Seqlane operational host", {
      cause,
    });
  }
}
