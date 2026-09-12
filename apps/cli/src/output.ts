import {
  createExecutionRenderer,
  type ExecutionRenderer,
  type OutputCapabilities,
  type OutputMode,
  type OutputSink,
  type RendererMode,
} from "@seqlane/output";
import { appendFileSync } from "node:fs";

export interface CliOutputStreams {
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly env?: NodeJS.ProcessEnv;
}

export function isCIEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" || env.GITHUB_ACTIONS === "true";
}

export function resolveRendererMode(
  mode: OutputMode,
  capabilities: Pick<OutputCapabilities, "isTTY" | "supportsAnsi">,
  env: NodeJS.ProcessEnv = process.env,
): RendererMode {
  if (mode !== "auto") return mode;
  return capabilities.isTTY &&
    capabilities.supportsAnsi &&
    !isCIEnvironment(env)
    ? "human"
    : "ci";
}

function streamSink(stream: NodeJS.WriteStream): OutputSink {
  return {
    write(value) {
      stream.write(value);
    },
  };
}

function summarySink(path: string): OutputSink {
  return {
    write(value) {
      appendFileSync(path, value, "utf8");
    },
  };
}

function configuredRedactions(env: NodeJS.ProcessEnv): readonly string[] {
  return [
    env.OPENAI_API_KEY,
    env.GITHUB_TOKEN,
    ...(env.SEQLANE_REDACT_VALUES?.split(/\r?\n/) ?? []),
  ].filter(
    (value, index, values): value is string =>
      value !== undefined &&
      value.length >= 4 &&
      values.indexOf(value) === index,
  );
}

export function createOutputCapabilities(
  streams: CliOutputStreams = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): OutputCapabilities {
  const env = streams.env ?? process.env;
  const isTTY = streams.stdout.isTTY === true;
  const term = env.TERM;
  const supportsAnsi = isTTY && env.NO_COLOR === undefined && term !== "dumb";
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
  const supportsUnicode = !/^(C|POSIX)([.@].*)?$/.test(locale);
  const summaryPath = env.GITHUB_STEP_SUMMARY;

  return {
    isTTY,
    supportsAnsi,
    supportsUnicode,
    width: Math.max(1, streams.stdout.columns ?? 80),
    stdout: streamSink(streams.stdout),
    stderr: streamSink(streams.stderr),
    redactions: configuredRedactions(env),
    ...(summaryPath === undefined ? {} : { summary: summarySink(summaryPath) }),
    ...(isCIEnvironment(env)
      ? { githubActions: { annotations: streamSink(streams.stderr) } }
      : {}),
  };
}

export function createCliRenderer(
  mode: OutputMode,
  capabilities: OutputCapabilities,
  env: NodeJS.ProcessEnv = process.env,
): { readonly mode: RendererMode; readonly renderer: ExecutionRenderer } {
  const resolvedMode = resolveRendererMode(mode, capabilities, env);
  return {
    mode: resolvedMode,
    renderer: createExecutionRenderer(resolvedMode, capabilities),
  };
}

export function connectTerminalResize(
  renderer: ExecutionRenderer,
  streams: Pick<NodeJS.WriteStream, "on" | "removeListener" | "columns">,
): () => void {
  if (
    renderer.mode !== "human" ||
    typeof streams.on !== "function" ||
    typeof streams.removeListener !== "function"
  ) {
    return () => undefined;
  }

  const resizable = renderer as ExecutionRenderer & {
    updateTerminal?: (update: { width?: number }) => void;
  };
  if (resizable.updateTerminal === undefined) return () => undefined;
  const onResize = (): void => {
    resizable.updateTerminal?.({
      width: Math.max(1, streams.columns ?? 80),
    });
  };
  streams.on("resize", onResize);
  return () => streams.removeListener("resize", onResize);
}
