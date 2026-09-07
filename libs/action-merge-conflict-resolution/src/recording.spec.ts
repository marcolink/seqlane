// @test-scope ./recording.ts

import { describe, expect, it } from "vitest";

import {
  REDACTED_VALUE,
  createBoundedRecording,
  formatBoundedRecording,
} from "./recording.js";

describe("bounded Seqlane recording", () => {
  it("redacts the secret and bounds event count", () => {
    const recording = createBoundedRecording("secret", 1, 10_000);
    const event = {
      type: "run.started",
      workId: "secret",
      runId: "run",
    } as const;

    recording.record(event);
    recording.record({ ...event, runId: "second" });

    expect(recording.events).toHaveLength(1);
    expect(recording.events[0]).toMatchObject({ workId: REDACTED_VALUE });
    expect(recording.truncated).toBe(true);
  });

  it("bounds encoded event bytes", () => {
    const recording = createBoundedRecording(undefined, 10, 20);
    recording.record({
      type: "run.started",
      workId: "work",
      runId: "run",
    });

    expect(recording.events).toHaveLength(0);
    expect(recording.truncated).toBe(true);
  });

  it("redacts every configured secret in the bounded representation", () => {
    const recording = createBoundedRecording([
      "github-secret",
      "openai-secret",
    ]);
    recording.record({
      type: "run.started",
      workId: "github-secret",
      runId: "openai-secret",
    });

    const formatted = formatBoundedRecording(recording);
    expect(formatted).toBe("Diagnostics: 1 bounded event(s); truncated: false");
    expect(formatted).not.toContain("github-secret");
    expect(formatted).not.toContain("openai-secret");
    expect(formatted).not.toContain(REDACTED_VALUE);
  });
});
