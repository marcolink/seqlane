import { describe, expect, it } from "vitest";
import {
  createStudioTransport,
  parseStudioReplayPayload,
  parseStudioRunSnapshot,
  parseStudioRunsSnapshot,
  parseStudioStreamEvent,
} from "./transport.js";

const run = {
  workId: "work-1",
  runId: "run-1",
  workflowId: "workflow-1",
  state: "active",
  isIncomplete: false,
  activeInvocationCount: 0,
  lastEventSequence: 1,
};

describe("Studio browser transport", () => {
  it("accepts a valid stream event payload", () => {
    const event = parseStudioStreamEvent(
      JSON.stringify({
        cursor: 1,
        workflowId: "workflow-1",
        event: {
          type: "run.started",
          workId: "work-1",
          runId: "run-1",
          metadata: {
            schemaVersion: 1,
            eventId: "event-1",
            sequence: 1,
            occurredAt: "2026-08-18T00:00:00.000Z",
          },
        },
      }),
    );

    expect(event.cursor).toBe(1);
    expect(event.event.type).toBe("run.started");
  });

  it("accepts tool activity stream events", () => {
    const event = parseStudioStreamEvent(
      JSON.stringify({
        cursor: 2,
        workflowId: "workflow-1",
        event: {
          type: "invocation.activity",
          workId: "work-1",
          runId: "run-1",
          invocationId: "invocation-1",
          activityId: "call-1",
          kind: "tool",
          name: "filesystem.read",
          state: "succeeded",
          metadata: {
            schemaVersion: 1,
            eventId: "event-2",
            sequence: 2,
            occurredAt: "2026-08-18T00:00:01.000Z",
          },
        },
      }),
    );

    expect(event.event.type).toBe("invocation.activity");
  });

  it("rejects malformed JSON and incomplete event envelopes", () => {
    expect(() => parseStudioStreamEvent("not-json")).toThrow(
      "Studio stream event must be valid JSON",
    );
    expect(() => parseStudioStreamEvent(JSON.stringify({ cursor: 1 }))).toThrow(
      "Studio stream event has an invalid shape",
    );
    expect(() =>
      parseStudioStreamEvent(
        JSON.stringify({
          cursor: 1,
          workflowId: "workflow-1",
          event: { type: "run.started" },
        }),
      ),
    ).toThrow("Studio stream event has an invalid shape");
    expect(() =>
      parseStudioStreamEvent(
        JSON.stringify({
          cursor: 1,
          workflowId: "workflow-1",
          event: {
            type: "unexpected.event",
            workId: "work-1",
            runId: "run-1",
            metadata: {
              schemaVersion: 1,
              eventId: "event-1",
              sequence: 1,
              occurredAt: "2026-08-18T00:00:00.000Z",
            },
          },
        }),
      ),
    ).toThrow("Studio stream event has an invalid shape");
    expect(() =>
      parseStudioStreamEvent(
        JSON.stringify({
          cursor: 2,
          workflowId: "workflow-1",
          event: {
            type: "invocation.activity",
            workId: "work-1",
            runId: "run-1",
            invocationId: "invocation-1",
            metadata: {
              schemaVersion: 1,
              eventId: "event-2",
              sequence: 2,
              occurredAt: "2026-08-18T00:00:01.000Z",
            },
          },
        }),
      ),
    ).toThrow("Studio stream event has an invalid shape");
  });

  it("rejects malformed run collections before projection", () => {
    expect(() =>
      parseStudioRunsSnapshot({
        runs: [{ ...run, lastEventSequence: -1 }],
        cursor: 1,
      }),
    ).toThrow("Studio runs response has an invalid shape");
  });

  it("accepts Plan session policy and rejects malformed policy", () => {
    const snapshot = {
      summary: run,
      cursor: 2,
      plan: {
        workflow: { id: "workflow-1" },
        nodes: [
          {
            planNodeId: "prepare:1",
            type: "task",
            label: "Prepare",
            dependsOn: [],
            siblingOrder: 0,
            session: { type: "isolated" },
          },
          {
            planNodeId: "review:1",
            type: "task",
            label: "Review",
            dependsOn: ["prepare:1"],
            siblingOrder: 1,
            session: { type: "branch", from: "prepare:1" },
          },
        ],
      },
      invocations: [],
    };

    expect(parseStudioRunSnapshot(snapshot).plan?.nodes[1]).toMatchObject({
      session: { type: "branch", from: "prepare:1" },
    });
    expect(() =>
      parseStudioRunSnapshot({
        ...snapshot,
        plan: {
          ...snapshot.plan,
          nodes: [
            ...snapshot.plan.nodes.slice(0, 1),
            { ...snapshot.plan.nodes[1], session: { type: "branch" } },
          ],
        },
      }),
    ).toThrow("Studio run response has an invalid shape");
  });

  it("accepts valid repeat iteration metadata and rejects zero", () => {
    const invocation = {
      invocationId: "invocation-1",
      planNodeId: "repeat:1/body/task:1",
      taskId: "task-a",
      kind: "task",
      label: "Process item",
      siblingOrder: 1,
      dependencyIds: [],
      iteration: 2,
      state: "succeeded",
      output: { persistent: [] },
    };

    const parsed = parseStudioRunSnapshot({
      summary: run,
      cursor: 2,
      toolUsage: [{ name: "filesystem.read", count: 7 }],
      skillUsage: [{ name: "web-perf", count: 1 }],
      invocations: [
        {
          ...invocation,
          activities: [
            {
              activityId: "call-1",
              kind: "tool",
              name: "filesystem.read",
              state: "succeeded",
              occurredAt: "2026-08-18T00:00:01.000Z",
            },
          ],
        },
      ],
    });
    expect(parsed.invocations[0]?.iteration).toBe(2);
    expect(parsed.toolUsage).toEqual([{ name: "filesystem.read", count: 7 }]);
    expect(parsed.skillUsage).toEqual([{ name: "web-perf", count: 1 }]);
    expect(parsed.invocations[0]?.activities?.[0]?.name).toBe(
      "filesystem.read",
    );
    expect(() =>
      parseStudioRunSnapshot({
        summary: run,
        cursor: 2,
        invocations: [{ ...invocation, iteration: 0 }],
      }),
    ).toThrow("Studio run response has an invalid shape");
  });

  it("parses a replay payload without exposing a filesystem path", () => {
    const replay = parseStudioReplayPayload({
      replayId: "replay-1",
      workflowId: "workflow-1",
      fileName: "recording.jsonl",
      events: [
        {
          cursor: 1,
          workflowId: "workflow-1",
          event: {
            type: "run.started",
            workId: "work-1",
            runId: "run-1",
            metadata: {
              schemaVersion: 1,
              eventId: "event-1",
              sequence: 1,
              occurredAt: "2026-08-18T00:00:00.000Z",
            },
          },
        },
      ],
    });

    expect(replay.fileName).toBe("recording.jsonl");
    expect(replay.events[0]?.event.type).toBe("run.started");
    expect(() => parseStudioReplayPayload({ replayId: "replay-1" })).toThrow(
      "Studio replay response has an invalid shape",
    );
  });

  it("loads replay data through the read-only replay endpoint", async () => {
    const requests: string[] = [];
    const transport = createStudioTransport(async (input) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          replayId: "replay/1",
          workflowId: "workflow-1",
          fileName: "recording.jsonl",
          events: [
            {
              cursor: 1,
              workflowId: "workflow-1",
              event: {
                type: "run.started",
                workId: "work-1",
                runId: "run-1",
                metadata: {
                  schemaVersion: 1,
                  eventId: "event-1",
                  sequence: 1,
                  occurredAt: "2026-08-18T00:00:00.000Z",
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    await transport.loadReplay("replay/1");

    expect(requests).toEqual(["/api/replay/replay%2F1"]);
  });
});
