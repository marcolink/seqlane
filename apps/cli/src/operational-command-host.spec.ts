// @test-scope ./operational-command-host.ts
// @test-scope ./commands/unstable_serve.ts
import { EventEmitter } from "node:events";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOperationalHostMock, loadOperationalWorkflowsMock } = vi.hoisted(
  () => ({
    createOperationalHostMock: vi.fn(),
    loadOperationalWorkflowsMock: vi.fn(),
  }),
);

vi.mock("@seqlane/runtime/operational-host", () => ({
  createOperationalHost: createOperationalHostMock,
  createOperationalWorkflow: vi.fn(),
}));
vi.mock("@seqlane/runtime/workflow", () => ({
  loadWorkflow: vi.fn(),
}));
vi.mock("./operational-workflows.js", () => ({
  loadOperationalWorkflows: loadOperationalWorkflowsMock,
}));

import { operationalServeLifetime } from "./commands/unstable_serve.js";
import { createOwnedOperationalHost } from "./operational-command-host.js";

describe("owned operational host composition", () => {
  const roots = { repository: "/repo/workflows", user: "/user/workflows" };
  let host: {
    listen: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    host = {
      listen: vi.fn(async () => "http://127.0.0.1:4111"),
      close: vi.fn(async () => undefined),
    };
    createOperationalHostMock.mockReset().mockResolvedValue(host);
    loadOperationalWorkflowsMock.mockReset().mockResolvedValue([]);
  });

  it("creates without listening, then the scoped lifetime listens and closes once", async () => {
    const signals = new EventEmitter();
    const logs: string[] = [];
    const running = Effect.runPromise(
      operationalServeLifetime(
        () => createOwnedOperationalHost({ roots }),
        (message) => logs.push(message),
        signals,
      ),
    );

    await vi.waitFor(() => expect(host.listen).toHaveBeenCalledOnce());
    expect(host.close).not.toHaveBeenCalled();
    signals.emit("SIGTERM");
    await expect(running).resolves.toBeUndefined();

    expect(host.listen).toHaveBeenCalledOnce();
    expect(host.close).toHaveBeenCalledOnce();
    expect(logs).toEqual([
      "Seqlane operational host: http://127.0.0.1:4111",
      "Seqlane readiness: http://127.0.0.1:4111/readyz",
    ]);
  });

  it("closes a host acquired after SIGTERM during workflow loading without listening", async () => {
    const signals = new EventEmitter();
    let resolveWorkflows: ((workflows: never[]) => void) | undefined;
    loadOperationalWorkflowsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWorkflows = resolve;
        }),
    );
    const logs: string[] = [];
    const running = Effect.runPromise(
      operationalServeLifetime(
        () => createOwnedOperationalHost({ roots }),
        (message) => logs.push(message),
        signals,
      ),
    );

    await vi.waitFor(() => expect(signals.listenerCount("SIGTERM")).toBe(1));
    signals.emit("SIGTERM");
    resolveWorkflows?.([]);
    await expect(running).resolves.toBeUndefined();

    expect(host.listen).not.toHaveBeenCalled();
    expect(host.close).toHaveBeenCalledOnce();
    expect(logs).toEqual([]);
  });

  it("closes the acquired host when listening fails", async () => {
    const signals = new EventEmitter();
    const failure = new Error("listen failed");
    host.listen.mockRejectedValueOnce(failure);

    await expect(
      Effect.runPromise(
        operationalServeLifetime(
          () => createOwnedOperationalHost({ roots }),
          () => undefined,
          signals,
        ),
      ),
    ).rejects.toBe(failure);

    expect(host.listen).toHaveBeenCalledOnce();
    expect(host.close).toHaveBeenCalledOnce();
  });
});
