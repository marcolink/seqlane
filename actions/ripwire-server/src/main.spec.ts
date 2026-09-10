// @test-scope ./main.ts

import { describe, expect, it, vi } from "vitest";
import { RipwireInstallError } from "./release.js";
import { CLEANUP_ONLY_STATE_KEY, parseCleanupOnlyState } from "./state.js";
import { recordInstallFailure } from "./main.js";

describe("Ripwire acquisition failure handling", () => {
  it("persists cleanup-only state, warns, and keeps the original cause", () => {
    const cause = new Error("download failed");
    const cleanupError = new Error("remove failed");
    const error = new RipwireInstallError(
      cause,
      "/tmp/ripwire-install",
      cleanupError,
    );
    const saveState = vi.fn();
    const warning = vi.fn();

    recordInstallFailure(error, { saveState, warning });

    expect(error.cause).toBe(cause);
    expect(saveState).toHaveBeenNthCalledWith(
      1,
      "install-directory",
      "/tmp/ripwire-install",
    );
    const marker = saveState.mock.calls.find(
      ([name]) => name === CLEANUP_ONLY_STATE_KEY,
    )?.[1];
    expect(parseCleanupOnlyState(marker)).toBe(true);
    expect(warning).toHaveBeenCalledWith(
      "Ripwire partial install cleanup failed: remove failed",
    );
  });

  it("warns before state persistence can fail", () => {
    const error = new RipwireInstallError(
      new Error("download failed"),
      "/tmp/ripwire-install",
      new Error("remove failed"),
    );
    const warning = vi.fn();
    const saveState = vi.fn(() => {
      throw new Error("state store failed");
    });

    expect(() => recordInstallFailure(error, { saveState, warning })).toThrow(
      "state store failed",
    );
    expect(warning).toHaveBeenCalledWith(
      "Ripwire partial install cleanup failed: remove failed",
    );
  });
});
