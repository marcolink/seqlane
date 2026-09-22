import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandRunnerOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandRunnerOptions,
) => Promise<CommandResult>;

function stringProperty(value: unknown, property: string): string {
  if (typeof value !== "object" || value === null) return "";
  const propertyValue = Reflect.get(value, property);
  return typeof propertyValue === "string" ? propertyValue : "";
}

function numberProperty(value: unknown, property: string): number | null {
  if (typeof value !== "object" || value === null) return null;
  const propertyValue = Reflect.get(value, property);
  return typeof propertyValue === "number" ? propertyValue : null;
}

export const nodeCommandRunner: CommandRunner = async (
  command,
  args,
  options,
): Promise<CommandResult> => {
  try {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: options.maxOutputBytes,
      timeout: options.timeoutMs,
      windowsHide: true,
    });

    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: 0,
      timedOut: false,
    };
  } catch (error: unknown) {
    const errorCode = stringProperty(error, "code");
    return {
      stdout: stringProperty(error, "stdout"),
      stderr: stringProperty(error, "stderr"),
      exitCode: numberProperty(error, "code"),
      timedOut:
        errorCode === "ETIMEDOUT" || stringProperty(error, "signal") !== "",
    };
  }
};
