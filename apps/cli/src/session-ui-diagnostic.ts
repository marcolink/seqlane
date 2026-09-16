import type { OutputCapabilities } from "@seqlane/tui";
import { encodeTerminalField } from "@seqlane/tui/terminal-field";
import { writeDiagnostic } from "./command.js";

export function writeSessionUiDiagnostic(
  capabilities: Pick<OutputCapabilities, "stderr" | "redactions">,
  browserUrl: string,
): void {
  writeDiagnostic(
    capabilities.stderr,
    `Seqlane session UI: ${encodeTerminalField(browserUrl, capabilities.redactions)}`,
  );
}
