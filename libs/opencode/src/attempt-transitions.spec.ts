// @test-scope ./attempt-transitions.ts
import { describe, expect, it } from "vitest";
import {
  createAttemptTransitionDispatcher,
  type AttemptTransitionCallbacks,
} from "./attempt-transitions.js";
import type {
  OpenCodeEventObservation,
  OpenCodeLegacyToolObservation,
} from "./observations.js";

describe("attempt observation transitions", () => {
  it("retains native tool details when a terminal event omits them", () => {
    const observations: OpenCodeEventObservation[] = [];
    const callbacks: AttemptTransitionCallbacks = {
      onActivity: undefined,
      onObservation: (observation) => observations.push(observation),
    };
    const dispatcher = createAttemptTransitionDispatcher(callbacks);
    dispatcher.observation({
      kind: "tool",
      sessionID: "session-1",
      messageID: "message-1",
      callID: "call-1",
      tool: "read",
      status: "running",
      input: { path: "src/main.ts" },
      output: "file contents",
      metadata: { source: "sdk" },
      startedAt: 10,
    });
    dispatcher.observation({
      kind: "tool",
      sessionID: "session-1",
      messageID: "message-1",
      callID: "call-1",
      tool: "read",
      status: "completed",
    });

    expect(observations[1]).toMatchObject({
      status: "completed",
      input: { path: "src/main.ts" },
      output: "file contents",
      metadata: { source: "sdk" },
      startedAt: 10,
    });
  });

  it("retains legacy tool details through terminal activity", () => {
    const activities: unknown[] = [];
    const dispatcher = createAttemptTransitionDispatcher({
      onActivity: (activity) => activities.push(activity),
      onObservation: undefined,
    });
    const started: OpenCodeLegacyToolObservation = {
      sessionID: "session-1",
      messageID: "message-1",
      callID: "call-1",
      tool: "read",
      status: "called",
      input: { path: "src/main.ts" },
      output: { bytes: 12 },
      metadata: { source: "sdk" },
      startedAt: 10,
    };
    dispatcher.legacyTool(started);
    dispatcher.legacyTool({
      sessionID: "session-1",
      callID: "call-1",
      status: "completed",
    });

    expect(activities[1]).toMatchObject({
      state: "succeeded",
      input: { path: "src/main.ts" },
      output: { bytes: 12 },
      metadata: { source: "sdk" },
      startedAt: 10,
    });
  });
});
