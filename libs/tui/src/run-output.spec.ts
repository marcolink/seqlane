import { expect, it } from "vitest";
import { outputBytes, retainOutput } from "./run-output.js";
import type { OutputEvent, RunOutputState } from "./run-view-model.js";
const event: Extract<OutputEvent, { type: "invocation.output" }> = {
  type: "invocation.output",
  workId: "work",
  runId: "run",
  invocationId: "task",
  metadata: {
    schemaVersion: 1,
    eventId: "event",
    sequence: 1,
    occurredAt: "2026-09-16T00:00:00Z",
  },
  policy: "persistent",
  channel: "task",
  content: "😀payload",
};
it.each([0, 1, 8, 64])(
  "retains bounded UTF-8 content after 10,000 overflow events (%i bytes)",
  (budget) => {
    let output: RunOutputState = { persistent: [] };
    for (let index = 0; index < 10000; index += 1)
      output = retainOutput(output, event, budget - outputBytes(output));
    expect(outputBytes(output)).toBeLessThanOrEqual(budget);
    expect(output.truncated).toBe(true);
    expect(output.persistent.join("")).not.toContain("�");
    const persistent = output.persistent;
    output = retainOutput(output, { ...event, metrics: { cost: 1 } }, 0);
    expect(output.persistent).toBe(persistent);
    expect(output.metrics?.cost).toBe(1);
  },
);
it("bounds array overhead independently of text bytes", () => {
  let output: RunOutputState = { persistent: [] };
  for (let index = 0; index < 10000; index += 1)
    output = retainOutput(output, { ...event, content: "x" }, 100000);
  expect(output.persistent).toHaveLength(128);
  expect(outputBytes(output)).toBe(128);
  expect(output.truncated).toBe(true);
});

it.each([
  ["abcdef", 3, 6, 3],
  ["😀ab", 5, 6, 1],
] as const)(
  "records original and omitted UTF-8 bytes for %s",
  (content, budget, originalBytes, omittedBytes) => {
    const output = retainOutput(
      { persistent: [] },
      { ...event, content },
      budget,
    );
    expect(output.originalBytes).toBe(originalBytes);
    expect(output.omittedBytes).toBe(omittedBytes);
    expect(outputBytes(output)).toBe(originalBytes - omittedBytes);
    expect(output.persistent.join("")).not.toContain("�");
  },
);
