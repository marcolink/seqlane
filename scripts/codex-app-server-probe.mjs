#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PROBE_OUTPUT_SCHEMA } from "./codex-app-server-probe-constants.mjs";
import { parseArgs } from "./codex-app-server-probe-cli.mjs";
import {
  findAgentMessage,
  parseInitializeResult,
  parseJsonLine,
  parseModelListResult,
  parseThreadResult,
  parseTurnResult,
  readCodexVersion,
} from "./codex-app-server-probe-protocol.mjs";
import {
  AppServerClient,
  requireDistinctThread,
  runProbe,
} from "./codex-app-server-probe-run.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = await runProbe(options);
  const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
  if (options.output === undefined) process.stdout.write(serialized);
  else {
    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized, "utf8");
    console.log(`Wrote sanitized Codex protocol fixture to ${output}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  });
}

export {
  AppServerClient,
  PROBE_OUTPUT_SCHEMA,
  findAgentMessage,
  parseInitializeResult,
  parseJsonLine,
  parseModelListResult,
  parseThreadResult,
  parseTurnResult,
  readCodexVersion,
  requireDistinctThread,
  runProbe,
};
