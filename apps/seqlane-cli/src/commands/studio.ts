import { Command, Flags } from "@oclif/core";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

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
    serverHost: Flags.string({
      description: "Host of the Seqlane/Mastra API server",
      default: "127.0.0.1",
    }),
    serverPort: Flags.integer({
      description: "Port of the Seqlane/Mastra API server",
      default: 4111,
    }),
    serverProtocol: Flags.string({
      description: "Protocol of the Seqlane/Mastra API server",
      options: ["http", "https"],
      default: "http",
    }),
    serverApiPrefix: Flags.string({
      description: "API route prefix of the Seqlane/Mastra server",
      default: "/api",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StudioCommand);
    let studio: CommunityStudioProcess;
    try {
      studio = launchCommunityStudio({
        port: flags.port,
        serverHost: flags.serverHost,
        serverPort: flags.serverPort,
        serverProtocol: flags.serverProtocol as "http" | "https",
        serverApiPrefix: flags.serverApiPrefix,
      });
    } catch (error) {
      this.error(errorMessage(error));
    }

    this.log(`Mastra Community Studio: ${studio.address}`);

    const exit = await waitForCommunityStudio(studio.process);
    if (exit.code !== 0 || exit.signal !== null) {
      process.exitCode = communityStudioExitCode(exit);
    }
  }
}
