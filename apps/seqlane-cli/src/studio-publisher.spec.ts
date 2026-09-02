import type {
  RunPlanEvent,
  RunStartedEvent,
  SeqlaneExecutionEvent,
  SeqlaneExecutionEventConsumer,
} from "@seqlane/events";
import { describe, expect, it } from "vitest";
import { startStudioSession } from "@seqlane/studio";
import { createStudioPublisher } from "./studio-publisher.js";

const address = "http://127.0.0.1:1234";

function event(sequence: number): SeqlaneExecutionEvent {
  return {
    type: "run.heartbeat",
    metadata: {
      schemaVersion: 1,
      eventId: `event-${sequence}`,
      sequence,
      occurredAt: "2026-08-18T00:00:00.000Z",
    },
    workId: "work-1",
    runId: "run-1",
    activeInvocationIds: [],
    elapsedMs: sequence,
  };
}

function runStarted(): SeqlaneExecutionEvent {
  return {
    type: "run.started",
    metadata: {
      schemaVersion: 1,
      eventId: "run-started",
      sequence: 1,
      occurredAt: "2026-08-18T00:00:00.000Z",
    },
    workId: "work-1",
    runId: "run-1",
  };
}

describe("Studio publisher", () => {
  const canonicalStarted: RunStartedEvent = {
    type: "run.started",
    metadata: {
      schemaVersion: 1,
      eventId: "started-1",
      sequence: 1,
      occurredAt: "2026-08-22T12:00:00.000Z",
    },
    workId: "work-1",
    runId: "run-1",
  };

  it("implements the canonical consumer contract and forwards run.plan", async () => {
    const payloads: { workflowId: string; event: unknown }[] = [];
    const publisher: SeqlaneExecutionEventConsumer = createStudioPublisher(
      address,
      "workflow-1",
      {
        send: async (payload) => {
          payloads.push(payload);
        },
      },
    );
    const plan: RunPlanEvent = {
      type: "run.plan",
      metadata: {
        schemaVersion: 1,
        eventId: "plan-1",
        sequence: 2,
        occurredAt: "2026-08-22T12:00:00.000Z",
      },
      workId: "work-1",
      runId: "run-1",
      plan: { workflow: { id: "workflow-1" }, nodes: [] },
    };

    publisher.consume(canonicalStarted);
    publisher.consume(plan);
    await publisher.flush();
    await publisher.close();

    expect(
      payloads.map(({ event }) => (event as { type: string }).type),
    ).toEqual(["run.started", "run.plan"]);
  });

  it("delivers queued events in order with workflow context", async () => {
    const payloads: {
      workflowId: string;
      event: SeqlaneExecutionEvent;
    }[] = [];
    const publisher = createStudioPublisher(address, "workflow-1", {
      send: async (payload) => {
        payloads.push(payload);
      },
    });

    publisher.publish(event(1));
    publisher.publish(event(2));
    publisher.publish(event(3));
    await publisher.close();

    expect(
      payloads.map(({ event: value }) => value.metadata?.sequence),
    ).toEqual([1, 2, 3]);
    expect(
      payloads.every(({ workflowId }) => workflowId === "workflow-1"),
    ).toBe(true);
  });

  it("forwards to an authenticated local Studio session", async () => {
    const session = await startStudioSession({ port: 0 });
    try {
      const publisher = createStudioPublisher(session.address, "workflow-1");
      publisher.publish(runStarted());
      await publisher.close();

      const response = await fetch(`${session.address}/api/runs`);
      expect(await response.json()).toMatchObject({
        runs: [{ runId: "run-1", workflowId: "workflow-1" }],
      });
    } finally {
      await session.stop();
    }
  });

  it("disables forwarding after one delivery failure", async () => {
    const diagnostics: string[] = [];
    const delivered: number[] = [];
    const publisher = createStudioPublisher(address, "workflow-1", {
      send: async ({ event: value }) => {
        delivered.push(value.metadata?.sequence ?? 0);
        throw new Error("studio stopped");
      },
      onDiagnostic: (message) => diagnostics.push(message),
    });

    publisher.publish(event(1));
    publisher.publish(event(2));
    await expect(publisher.close()).resolves.toBeUndefined();
    publisher.publish(event(3));

    expect(delivered).toEqual([1]);
    expect(diagnostics).toEqual(["Studio forwarding disabled: studio stopped"]);
  });

  it("stops accepting events when its finite queue overflows", async () => {
    let release!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    const diagnostics: string[] = [];
    const publisher = createStudioPublisher(address, "workflow-1", {
      maxQueueSize: 2,
      send: async () => firstDelivery,
      onDiagnostic: (message) => diagnostics.push(message),
    });

    publisher.publish(event(1));
    publisher.publish(event(2));
    publisher.publish(event(3));
    publisher.publish(event(4));
    release();
    await publisher.close();

    expect(diagnostics).toEqual([
      "Studio forwarding disabled: Studio event queue is full",
    ]);
  });
});
