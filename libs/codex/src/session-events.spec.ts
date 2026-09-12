// @test-scope ./session-events.ts
import { describe, expect, it } from "vitest";
import type { CodexInboundMessage } from "./protocol.js";
import { CodexSessionEventDispatcher } from "./session-events.js";
import type { CodexTransport } from "./transport.js";

class FakeTransport implements CodexTransport {
  readonly termination = Promise.resolve();
  private listener?: (message: CodexInboundMessage) => void;

  request(): Promise<unknown> {
    return Promise.resolve();
  }

  respond(): void {
    // No response is expected for this malformed request.
  }

  subscribe(listener: (message: CodexInboundMessage) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  emit(message: CodexInboundMessage): void {
    this.listener?.(message);
  }
}

describe("Codex session event dispatcher", () => {
  it("fails on an uncorrelated server request", () => {
    const transport = new FakeTransport();
    new CodexSessionEventDispatcher(transport);

    expect(() =>
      transport.emit({
        kind: "server-request",
        request: { id: 1, method: "unsupported", params: {} },
      }),
    ).toThrow("uncorrelated server request");
  });
});
