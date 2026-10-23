import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { InteractionRequestedEvent } from "@seqlane/protocol";
import type { UserInputView } from "@seqlane/tui";
import { createTerminalUserInputConsumer } from "./terminal-user-input.js";

const request: InteractionRequestedEvent = {
  type: "interaction.requested",
  kind: "user-input",
  workId: "work",
  runId: "run",
  invocationId: "invocation",
  subject: { type: "task", taskId: "task" },
  requestId: "request",
  questions: [{ id: "note", prompt: "Note?", allowFreeText: true }],
  expiresAt: "2026-10-24T12:00:00.000Z",
  metadata: {
    schemaVersion: 1,
    eventId: "event",
    sequence: 1,
    occurredAt: "2026-10-24T11:00:00.000Z",
  },
};
function setup() {
  const stdin = new PassThrough();
  const capabilities = { terminal: { stdin } };
  let view: UserInputView | undefined;
  const consumer = createTerminalUserInputConsumer(capabilities, (next) => {
    view = next;
  });
  return { consumer, stdin, current: () => view };
}
describe("terminal input queue", () => {
  it("cancels on terminal loss before an agent asks its first question", () => {
    const { consumer, stdin } = setup();
    const cancelRun = vi.fn();
    consumer.bindCancellation(cancelRun);
    stdin.emit("end");
    stdin.emit("close");
    expect(cancelRun).toHaveBeenCalledOnce();
  });
  it("remembers terminal loss while the runner is starting", () => {
    const { consumer, stdin } = setup();
    const cancelRun = vi.fn();
    stdin.emit("end");
    consumer.bindCancellation(cancelRun);
    expect(cancelRun).toHaveBeenCalledOnce();
  });
  it("keeps FIFO requests until canonical resolution and ignores stale controls", async () => {
    const { consumer, current } = setup();
    const respond = vi.fn(async () => undefined);
    consumer.onRequested(request, respond, vi.fn());
    const stale = current();
    consumer.onRequested(
      { ...request, requestId: "second", invocationId: "second" },
      respond,
      vi.fn(),
    );
    expect(current()?.pendingCount).toBe(2);
    current()?.onSubmit({ note: "  exact spaces  " });
    current()?.onSubmit({ note: "duplicate" });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]).toEqual([
      {
        type: "interaction.respond",
        runId: "run",
        invocationId: "invocation",
        requestId: "request",
        answers: { note: "  exact spaces  " },
      },
    ]);
    await Promise.resolve();
    expect(current()?.requestId).toBe("request");
    consumer.handle({
      ...request,
      type: "interaction.resolved",
      status: "answered",
    });
    stale?.onSubmit({ note: "too late" });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(current()?.requestId).toBe("second");
    expect(current()?.pendingCount).toBe(1);
    consumer.close();
  });
  it("removes queued expiry and lets a rejected answer be corrected", () => {
    const { consumer, current } = setup();
    const respond = vi.fn(async () => undefined);
    consumer.onRequested(request, respond, vi.fn());
    consumer.onRequested({ ...request, requestId: "second" }, respond, vi.fn());
    consumer.handle({
      ...request,
      type: "interaction.resolved",
      requestId: "second",
      status: "expired",
    });
    current()?.onSubmit({ note: " " });
    expect(respond).not.toHaveBeenCalled();
    current()?.onSubmit({ note: "valid" });
    consumer.handle({
      ...request,
      type: "interaction.response",
      status: "rejected",
      code: "INVALID_ANSWER",
    });
    expect(current()?.submitting).toBe(false);
    current()?.onSubmit({ note: "corrected" });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(current()?.pendingCount).toBe(1);
    consumer.close();
  });
  it.each(["end", "close"])(
    "cancels once on stdin %s and removes all listeners",
    (event) => {
      const { consumer, current, stdin } = setup();
      const cancel = vi.fn();
      consumer.onRequested(request, vi.fn(), cancel);
      stdin.emit(event);
      stdin.emit(event);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(current()).toBeUndefined();
      expect(stdin.listenerCount("end")).toBe(0);
      expect(stdin.listenerCount("close")).toBe(0);
    },
  );
  it("cancels an uncertain IPC write without retrying", async () => {
    const { consumer, current } = setup();
    const cancel = vi.fn();
    const respond = vi.fn(async () => {
      throw new Error("disconnected");
    });
    consumer.onRequested(request, respond, cancel);
    current()?.onSubmit({ note: "value" });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(respond).toHaveBeenCalledOnce();
    expect(current()).toBeUndefined();
  });
});
