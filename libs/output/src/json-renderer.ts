import { type SeqlaneExecutionEvent } from "@seqlane/protocol";
import type {
  ExecutionRenderer,
  OutputCapabilities,
} from "./renderer-contract.js";
import { redactOutput } from "./redaction.js";

export class JSONRenderer implements ExecutionRenderer {
  readonly mode = "json" as const;
  private readonly capabilities: OutputCapabilities;
  private _lastError: unknown;
  private finished = false;

  constructor(capabilities: OutputCapabilities) {
    this.capabilities = capabilities;
  }

  get lastError(): unknown {
    return this._lastError;
  }

  handle(event: SeqlaneExecutionEvent): void {
    if (this.finished) return;
    this.safeWrite(
      redactOutput(JSON.stringify(event), this.capabilities.redactions ?? []) +
        "\n",
    );
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.capabilities.stdout.flush?.();
  }

  private safeWrite(value: string): void {
    try {
      this.capabilities.stdout.write(value);
    } catch (error) {
      this._lastError ??= error;
    }
  }
}
