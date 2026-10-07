import { describe, expect, it, vi } from "vitest";
import {
  createReviewAdmissionDeadline,
  waitForReviewAuthority,
} from "./review-git-host-admission.js";

describe("hosted admission authority deadline", () => {
  it("expires 120 seconds after admission starts, including setup time", () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const deadline = createReviewAdmissionDeadline();
    try {
      vi.advanceTimersByTime(119_999);
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason).toMatchObject({
        resource: "admissionWallMs",
        observed: 120_000,
        limit: 120_000,
      });
    } finally {
      deadline.close();
      vi.useRealTimers();
    }
  });
  it("settles a stalled read on cancellation and preserves the reason", async () => {
    const controller = new AbortController();
    const cause = new Error("absolute deadline");
    const read = waitForReviewAuthority(
      new Promise<never>(() => undefined),
      controller.signal,
    );
    controller.abort(cause);
    await expect(read).rejects.toMatchObject({
      code: "REVIEW_ADMISSION_CANCELLED",
      cause,
    });
  });
  it("returns complete raw authority results without altering them", async () => {
    const page = { items: [], hasNextPage: false };
    expect(
      await waitForReviewAuthority(
        Promise.resolve(page),
        new AbortController().signal,
      ),
    ).toBe(page);
  });
});
