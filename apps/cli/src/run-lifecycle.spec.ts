// @test-scope ./run-lifecycle.ts

import { describe, expect, it, vi } from "vitest";
import { closeRunResources } from "./run-lifecycle.js";

function dispatcher() {
  return {
    consume: vi.fn(),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("closeRunResources", () => {
  it("closes a recording acquired before dispatcher setup fails", async () => {
    const recording = {
      consume: vi.fn(),
      flush: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    const result = await closeRunResources({
      recordingConsumer: recording,
      finishRenderer: vi.fn(async () => undefined),
      disconnectResize: vi.fn(),
    });

    expect(result).toEqual([]);
    expect(recording.flush).toHaveBeenCalledOnce();
    expect(recording.close).toHaveBeenCalledOnce();
  });

  it("attempts every cleanup callback when each one fails", async () => {
    const events = dispatcher();
    const errors = {
      before: new Error("before cleanup failed"),
      client: new Error("client close failed"),
      host: new Error("host close failed"),
      flush: new Error("event flush failed"),
      dispatcherFlush: new Error("dispatcher flush failed"),
      dispatcherClose: new Error("dispatcher close failed"),
      renderer: new Error("renderer finish failed"),
      rendererDiagnostic: new Error("renderer diagnostic failed"),
      resize: new Error("resize disconnect failed"),
    };
    events.flush.mockRejectedValue(errors.dispatcherFlush);
    events.close.mockRejectedValue(errors.dispatcherClose);

    const result = await closeRunResources({
      dispatcher: events,
      flushEvents: async () => {
        throw errors.flush;
      },
      closeClient: async () => {
        throw errors.client;
      },
      closeHost: async () => {
        throw errors.host;
      },
      finishRenderer: async () => {
        throw errors.renderer;
      },
      disconnectResize: () => {
        throw errors.resize;
      },
      beforeCleanup: () => {
        throw errors.before;
      },
      onRendererError: () => {
        throw errors.rendererDiagnostic;
      },
    });

    expect(result).toEqual([
      errors.before,
      errors.client,
      errors.host,
      errors.flush,
      errors.dispatcherFlush,
      errors.dispatcherClose,
      errors.renderer,
      errors.rendererDiagnostic,
      errors.resize,
    ]);
    expect(events.flush).toHaveBeenCalledOnce();
    expect(events.close).toHaveBeenCalledOnce();
  });

  it("retains the primary operation result when diagnostics fail", async () => {
    const events = dispatcher();
    const rendererError = new Error("renderer finish failed");
    const diagnosticError = new Error("diagnostic failed");
    const onRendererError = vi.fn(() => {
      throw diagnosticError;
    });

    const result = await closeRunResources({
      dispatcher: events,
      finishRenderer: async () => {
        throw rendererError;
      },
      onRendererError,
      disconnectResize: vi.fn(),
    });

    expect(result).toEqual([rendererError, diagnosticError]);
    expect(onRendererError).toHaveBeenCalledWith(rendererError);
  });
});
