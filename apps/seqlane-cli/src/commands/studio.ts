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
    address: `${serverProtocol}://127.0.0.1:${port}`,
    process: child,
  };
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

    await new Promise<void>((resolve, reject) => {
      studio.process.once("error", reject);
      studio.process.once("exit", () => resolve());
    });
  }
}
