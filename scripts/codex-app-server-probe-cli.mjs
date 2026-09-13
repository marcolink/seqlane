import { DEFAULT_TIMEOUT_MS } from "./codex-app-server-probe-constants.mjs";

export function parseArgs(argv) {
  const options = {
    executable: "codex",
    workspace: undefined,
    output: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      console.log(`Usage: node scripts/codex-app-server-probe.mjs [options]

Options:
  --executable PATH  Codex executable (default: codex)
  --workspace PATH   Explicit workspace; otherwise use a disposable temporary workspace
  --output PATH      Write the sanitized fixture to PATH
  --timeout MS       Per-operation timeout (default: ${DEFAULT_TIMEOUT_MS})`);
      process.exit(0);
    }
    if (argument === "--executable")
      options.executable = requireValue(argument, value, index);
    else if (argument === "--workspace")
      options.workspace = requireValue(argument, value, index);
    else if (argument === "--output")
      options.output = requireValue(argument, value, index);
    else if (argument === "--timeout")
      options.timeoutMs = Number(requireValue(argument, value, index));
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error(
      "--timeout must be an integer of at least 1000 milliseconds",
    );
  }
  if (options.workspace !== undefined && !options.workspace.startsWith("/")) {
    throw new Error("--workspace must be an absolute path");
  }
  return options;
}

function requireValue(argument, value, index) {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${argument} requires a value (argument ${index + 1})`);
  }
  return value;
}
