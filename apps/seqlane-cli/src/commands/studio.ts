import { Command, Flags } from "@oclif/core";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  loadRuntimeAdapterConfiguration,
  runtimeAdapterConfigurationEnvironment,
} from "@seqlane/runtime/operational-host";
import { parseOperationalServerUrl } from "../operational-client.js";
import { startOwnedOperationalHost } from "../operational-command-host.js";
import { workflowRootsFromFlags } from "../workflow-roots.js";

const packageRequire = createRequire(import.meta.url);

export interface CommunityStudioOptions {
  readonly port?: number;
  readonly serverHost?: string;
  readonly serverPort?: number;
  readonly serverProtocol?: "http" | "https";
  readonly serverApiPrefix?: string;
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
  readonly serverProtocol: "http" | "https";
  readonly serverApiPrefix: string;
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
    serverProtocol: "http",
    serverApiPrefix: "/api",
    origin: `http://${serverHost}:${serverPort}`,
  };
}

export function resolveStudioServerOptions(
  serverUrl: string | undefined,
  options: Pick<
    CommunityStudioOptions,
    "serverHost" | "serverPort" | "serverProtocol" | "serverApiPrefix"
  > = {},
): StudioServerOptions {
  if (serverUrl !== undefined) return loopbackServerOptions(serverUrl);
  const serverHost = options.serverHost ?? "127.0.0.1";
  const serverPort = options.serverPort ?? 4111;
  const serverProtocol = options.serverProtocol ?? "http";
  const serverApiPrefix = options.serverApiPrefix ?? "/api";
  if (serverProtocol !== "http") {
    throw new TypeError(
      "Owned operational host and Community Studio must use HTTP loopback",
    );
  }
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
    serverProtocol,
    serverApiPrefix,
    origin: normalized.origin,
  };
}

export async function waitForOperationalHostReady(
  origin: string,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = readinessTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const response = await fetchImplementation(`${origin}/readyz`);
      if (response.ok) return;
      lastError = new Error(`readiness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, readinessRetryMs));
  }
  throw new Error(
    `Operational host did not become ready: ${errorMessage(lastError)}`,
    {
      cause: lastError,
    },
  );
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
  const serverProtocol = options.serverProtocol ?? "http";
  const serverApiPrefix = options.serverApiPrefix ?? "/api";
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
      "--server-protocol",
      serverProtocol,
      "--server-api-prefix",
      serverApiPrefix,
    ],
    { stdio: "inherit" },
  );

  return {
    address: `http://127.0.0.1:${port}`,
    process: child,
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
    "server-protocol": Flags.string({
      description: "Protocol of the Seqlane/Mastra API server",
      options: ["http", "https"],
      default: "http",
    }),
    "server-api-prefix": Flags.string({
      description: "API route prefix of the Seqlane/Mastra server",
      default: "/api",
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
        serverProtocol: flags["server-protocol"] as "http" | "https",
        serverApiPrefix: flags["server-api-prefix"],
      });
    } catch (error) {
      this.error(errorMessage(error));
    }
    let ownedHost:
      Awaited<ReturnType<typeof startOwnedOperationalHost>> | undefined;
    try {
      if (flags["server-url"] === undefined) {
        const adapterConfiguration =
          process.env[runtimeAdapterConfigurationEnvironment] === undefined
            ? undefined
            : loadRuntimeAdapterConfiguration();
        ownedHost = await startOwnedOperationalHost({
          roots: workflowRootsFromFlags(flags),
          host: server.serverHost,
          port: server.serverPort,
          storageUrl: flags["storage-url"],
          adapterConfiguration,
        });
        await waitForOperationalHostReady(ownedHost.address);
        this.log(`Seqlane operational host: ${ownedHost.address}`);
      } else {
        await waitForOperationalHostReady(server.origin);
        this.log(`Seqlane operational host: ${server.origin}`);
      }

      const studio = launchCommunityStudio({
        port: flags.port,
        serverHost: server.serverHost,
        serverPort: server.serverPort,
        serverProtocol: server.serverProtocol,
        serverApiPrefix: server.serverApiPrefix,
      });
      this.log(`Mastra Community Studio: ${studio.address}`);
      const exit = await waitForCommunityStudio(studio.process);
      if (exit.code !== 0 || exit.signal !== null) {
        process.exitCode = communityStudioExitCode(exit);
      }
    } catch (error) {
      this.error(errorMessage(error));
    } finally {
      await ownedHost?.close().catch(() => undefined);
    }
  }
}
