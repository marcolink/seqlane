import { encodeSeqlaneExecutionEvent } from "@seqlane/protocol";
import type { ExecutionRenderer, OutputCapabilities } from "@seqlane/output";
import { connectTerminalResize } from "./output.js";
import { errorMessage, writeDiagnostic } from "./command.js";
import { iterateSeqlaneRecording, type SeqlaneRecording } from "./recording.js";

/** Stream validated recording events as canonical newline-delimited JSON. */
export function writeReplayEvents(
  path: string,
  stdout: { readonly write: (value: string) => void },
): void {
  for (const event of iterateSeqlaneRecording(path)) {
    stdout.write(encodeSeqlaneExecutionEvent(event) + "\n");
  }
}

/** Render a decoded recording and always release its terminal resize listener. */
export async function renderReplayRecording(options: {
  readonly recording: SeqlaneRecording;
  readonly renderer: ExecutionRenderer;
  readonly capabilities: OutputCapabilities;
  readonly terminal: Pick<
    NodeJS.WriteStream,
    "on" | "removeListener" | "columns"
  >;
}): Promise<void> {
  const { recording, renderer, capabilities, terminal } = options;
  const disconnectResize = connectTerminalResize(renderer, terminal);
  for (const event of recording.events) {
    try {
      renderer.handle(event);
    } catch (error) {
      writeDiagnostic(
        capabilities.stderr,
        "seqlane output error: " + errorMessage(error),
      );
    }
  }
  try {
    await renderer.finish();
  } catch (error) {
    writeDiagnostic(
      capabilities.stderr,
      "seqlane output error: " + errorMessage(error),
    );
  } finally {
    disconnectResize();
  }
}
