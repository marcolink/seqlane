import { Command, Flags } from "@oclif/core";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  agentRuntimeConfigurationEnvironment,
  loadAgentRuntimeFactory,
} from "../agent-runtime.js";
import { parseOperationalServerUrl } from "../operational-client.js";
import { startOwnedOperationalHost } from "../operational-command-host.js";
import { workflowRootsFromFlags } from "../workflow-roots.js";

const packageRequire = createRequire(import.meta.url);

export interface CommunityStudioOptions {
  readonly port?: number;
  readonly serverHost?: string;
  readonly serverPort?: number;
}

export interface CommunityStudioProcess {
  readonly address: string;
  readonly process: ChildProcess;
}

export interface CommunityStudioExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface CommunityStudioSignalSource {
  once(
    signal: "SIGINT" | "SIGTERM",
    listener: () => void,
  ): CommunityStudioSignalSource;
  removeListener(
    signal: "SIGINT" | "SIGTERM",
    listener: () => void,
  ): CommunityStudioSignalSource;
}

export interface StudioServerOptions {
  readonly serverHost: string;
  readonly serverPort: number;
  readonly origin: string;
}

const readinessTimeoutMs = 10_000;
const readinessRetryMs = 50;

function loopbackServerOptions(value: string): StudioServerOptions {
  let url: URL;
  try {
    url = parseOperationalServerUrl(value);
  } catch (cause) {
    throw new TypeError("Operational server URL is invalid", { cause });
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    !["localhost", "127.0.0.1", "::1"].includes(hostname) ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new TypeError(
      "Operational server URL must be an unauthenticated HTTP loopback origin",
    );
  }
  const serverHost = hostname === "::1" ? "[::1]" : hostname;
  const serverPort = Number(url.port || 80);
  return {
    serverHost,
    serverPort,
    origin: `http://${serverHost}:${serverPort}`,
  };
}

export function resolveStudioServerOptions(
  serverUrl: string | undefined,
  options: Pick<CommunityStudioOptions, "serverHost" | "serverPort"> = {},
): StudioServerOptions {
  if (serverUrl !== undefined) return loopbackServerOptions(serverUrl);
  const serverHost = options.serverHost ?? "127.0.0.1";
  const serverPort = options.serverPort ?? 4111;
  const hostForUrl =
    serverHost.includes(":") && !serverHost.startsWith("[")
      ? `[${serverHost}]`
      : serverHost;
  const normalized = parseOperationalServerUrl(
    `http://${hostForUrl}:${serverPort}`,
  );
  return {
    serverHost,
    serverPort,
    origin: normalized.origin,
  };
}

export async function waitForOperationalHostReady(
  origin: string,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = readinessTimeoutMs,
  abortSignal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (true) {
    if (abortSignal?.aborted) {
      lastError = abortSignal.reason;
      break;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(abortSignal?.reason);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    const abortTimer = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await fetchImplementation(`${origin}/readyz`, {
        signal: controller.signal,
      });
      try {
        await response.body?.cancel();
      } catch {
        // The response has been received; cleanup failure must not hide readiness.
      }
      if (response.ok) return;
      lastError = new Error(`readiness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(abortTimer);
      abortSignal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
    if (abortSignal?.aborted) {
      lastError = abortSignal.reason;
      break;
    }
    const retryMs = Math.min(readinessRetryMs, deadline - Date.now());
    if (retryMs <= 0) break;
    await waitForReadinessRetry(retryMs, abortSignal);
  }
  throw new Error(
    `Operational host did not become ready: ${errorMessage(lastError)}`,
    {
      cause: lastError,
    },
  );
}

function waitForReadinessRetry(
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    abortSignal?.addEventListener("abort", finish, { once: true });
  });
}

function communityStudioEntryPoint(): string {
  try {
    return packageRequire.resolve("mastra");
  } catch (cause) {
    throw new Error(
      'Mastra Community Studio is unavailable. Install the pinned "mastra" package.',
      { cause },
    );
  }
}

export function launchCommunityStudio(
  options: CommunityStudioOptions = {},
): CommunityStudioProcess {
  const port = options.port ?? 3000;
  const serverHost = options.serverHost ?? "127.0.0.1";
  const serverPort = options.serverPort ?? 4111;
  const child = spawn(
    process.execPath,
    [
      communityStudioEntryPoint(),
      "studio",
      "--port",
      String(port),
      "--server-host",
      serverHost,
      "--server-port",
      String(serverPort),
    ],
    { stdio: "inherit" },
  );

  return {
    address: `http://127.0.0.1:${port}`,
    process: child,
  };
}

type OwnedOperationalHost = Awaited<
  ReturnType<typeof startOwnedOperationalHost>
>;

export interface OwnedHostSignalLifecycle {
  readonly isShuttingDown: () => boolean;
  readonly signal: AbortSignal;
  readonly setOwnedHost: (host: OwnedOperationalHost) => void;
  readonly closeOwnedHost: () => Promise<void>;
  readonly cleanup: () => void;
}

export function createOwnedHostSignalLifecycle(
  signalSource: CommunityStudioSignalSource = process,
): OwnedHostSignalLifecycle {
  let shuttingDown = false;
  const shutdownController = new AbortController();
  let ownedHost: OwnedOperationalHost | undefined;
  let closePromise: Promise<void> | undefined;

  const closeOwnedHost = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    if (ownedHost === undefined) return Promise.resolve();
    const promise = ownedHost.close().catch(() => undefined);
    closePromise = promise;
    return promise;
  };
  const onSignal = (): void => {
    shuttingDown = true;
    shutdownController.abort();
    void closeOwnedHost();
  };

  signalSource.once("SIGINT", onSignal);
  signalSource.once("SIGTERM", onSignal);

  return {
    isShuttingDown: () => shuttingDown,
    signal: shutdownController.signal,
    setOwnedHost: (host) => {
      ownedHost = host;
      if (shuttingDown) void closeOwnedHost();
    },
    closeOwnedHost,
    cleanup: () => {
      signalSource.removeListener("SIGINT", onSignal);
      signalSource.removeListener("SIGTERM", onSignal);
    },
  };
}

export function waitForCommunityStudio(
  child: ChildProcess,
  signalSource: CommunityStudioSignalSource = process,
): Promise<CommunityStudioExit> {
  return new Promise((resolve, reject) => {
    let shuttingDown = false;

    const cleanup = (): void => {
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      signalSource.removeListener("SIGINT", onSigint);
      signalSource.removeListener("SIGTERM", onSigterm);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      resolve({ code, signal });
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      child.kill(signal);
    };
    const onSigint = (): void => onSignal("SIGINT");
    const onSigterm = (): void => onSignal("SIGTERM");

    child.once("error", onError);
    child.once("exit", onExit);
    signalSource.once("SIGINT", onSigint);
    signalSource.once("SIGTERM", onSigterm);
  });
}

export function communityStudioExitCode({
  code,
  signal,
}: CommunityStudioExit): number {
  if (code !== null) return code;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class StudioCommand extends Command {
  static override description =
    "Start the upstream Mastra Community Studio for a Seqlane runtime";

  static override examples = [
    "<%= config.bin %> studio",
    "<%= config.bin %> studio --port 3001 --server-port 4112",
  ];

  static override flags = {
    port: Flags.integer({
      description: "Loopback port for the Community Studio UI",
    }),
    "server-host": Flags.string({
      description: "Host of the Seqlane/Mastra API server",
      default: "127.0.0.1",
    }),
    "server-port": Flags.integer({
      description: "Port of the Seqlane/Mastra API server",
      default: 4111,
    }),
    "server-url": Flags.string({
      description: "Attach Studio to an existing loopback operational host",
    }),
    "storage-url": Flags.string({
      description: "Mastra LibSQL storage URL for the owned host",
      default: "file:./.seqlane/mastra.db",
    }),
    "repository-root": Flags.string({
      description: "Repository workflow descriptor root",
    }),
    "user-root": Flags.string({
      description: "User workflow descriptor root",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StudioCommand);
    let server: StudioServerOptions;
    try {
      server = resolveStudioServerOptions(flags["server-url"], {
        serverHost: flags["server-host"],
        serverPort: flags["server-port"],
      });
    } catch (error) {
      this.error(errorMessage(error));
    }
    const lifecycle = createOwnedHostSignalLifecycle();
    let ownedHost:
      Awaited<ReturnType<typeof startOwnedOperationalHost>> | undefined;
    try {
      if (flags["server-url"] === undefined) {
        const agentRuntime =
          process.env[agentRuntimeConfigurationEnvironment] === undefined
            ? undefined
            : loadAgentRuntimeFactory();
        ownedHost = await startOwnedOperationalHost({
          roots: workflowRootsFromFlags(flags),
          host: server.serverHost,
          port: server.serverPort,
          storageUrl: flags["storage-url"],
          agentRuntime,
        });
        lifecycle.setOwnedHost(ownedHost);
        if (lifecycle.isShuttingDown()) return;
        server = resolveStudioServerOptions(ownedHost.address);
        await waitForOperationalHostReady(
          server.origin,
          fetch,
          readinessTimeoutMs,
          lifecycle.signal,
        );
        this.log(`Seqlane operational host: ${server.origin}`);
      } else {
        if (lifecycle.isShuttingDown()) return;
        await waitForOperationalHostReady(
          server.origin,
          fetch,
          readinessTimeoutMs,
          lifecycle.signal,
        );
        this.log(`Seqlane operational host: ${server.origin}`);
      }

      if (lifecycle.isShuttingDown()) return;

      const studio = launchCommunityStudio({
        port: flags.port,
        serverHost: server.serverHost,
        serverPort: server.serverPort,
      });
      this.log(`Mastra Community Studio: ${studio.address}`);
      const exit = await waitForCommunityStudio(studio.process);
      if (exit.code !== 0 || exit.signal !== null) {
        process.exitCode = communityStudioExitCode(exit);
      }
    } catch (error) {
      if (!lifecycle.isShuttingDown()) this.error(errorMessage(error));
    } finally {
      lifecycle.cleanup();
      await lifecycle.closeOwnedHost();
    }
  }
}
