import { stat } from "node:fs/promises";

export async function assertDirectory(directory: string): Promise<void> {
  const details = await stat(directory);
  if (!details.isDirectory()) {
    throw new Error(
      `Configured working directory is not a directory: ${directory}`,
    );
  }
}
