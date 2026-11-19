// @test-scope ./post.ts

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = new Map<string, string>();
const terminate = vi.fn(() => Effect.succeed(true));
const warning = vi.fn();

vi.mock("@actions/core", () => ({
  getState: (name: string) => state.get(name) ?? "",
  info: vi.fn(),
  warning,
}));
vi.mock("@seqlane/action-service-lifecycle", async () => {
  const actual = await vi.importActual<
    typeof import("@seqlane/action-service-lifecycle")
  >("@seqlane/action-service-lifecycle");
  return { ...actual, terminateProcessGroup: terminate };
});

const { run } = await import("./post.js");

afterEach(() => {
  state.clear();
  terminate.mockClear();
  warning.mockClear();
});

describe("zvec-grep post cleanup", () => {
  it("skips cleanup when saved ownership is malformed", async () => {
    state.set("pid", "42");
    state.set("process-group-id", "not-a-pid");

    await run();

    expect(terminate).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("state is malformed"),
    );
  });

  it("terminates only the saved validated process and sentinel identities", async () => {
    state.set("pid", "42");
    state.set("process-group-id", "42");
    state.set("process-start-time", "primary-start");
    state.set("sentinel-pid", "41");
    state.set("sentinel-process-group-id", "42");
    state.set("sentinel-process-start-time", "sentinel-start");

    await run();

    expect(terminate).toHaveBeenCalledWith(
      42,
      { processGroupId: 42, processStartTime: "primary-start" },
      {
        pid: 41,
        identity: { processGroupId: 42, processStartTime: "sentinel-start" },
      },
    );
  });
});
