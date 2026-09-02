// @test-scope ./runtime-session-ui.ts
import { describe, expect, it } from "vitest";
import {
  decodeRuntimeSessionUiAvailable,
  encodeRuntimeSessionUiAvailable,
} from "./runtime-session-ui.js";

describe("runtime session UI runner messages", () => {
  it("round-trips an HTTP browser URL", () => {
    const message = {
      type: "runtime.session.ui-available" as const,
      invocationId: "invocation-1",
      browserUrl: "http://127.0.0.1:4096/L3JlcG8/session/ses_123",
    };

    expect(
      decodeRuntimeSessionUiAvailable(encodeRuntimeSessionUiAvailable(message)),
    ).toEqual(message);
  });

  it.each([
    "ftp://127.0.0.1/session/ses_123",
    "http://user:password@127.0.0.1/session/ses_123",
    "not a URL",
  ])("rejects an unsafe browser URL: %s", (browserUrl) => {
    expect(() =>
      encodeRuntimeSessionUiAvailable({
        type: "runtime.session.ui-available",
        invocationId: "invocation-1",
        browserUrl,
      }),
    ).toThrow("Invalid runtime session UI message");
  });

  it("rejects a notification without an invocation ID", () => {
    expect(() =>
      decodeRuntimeSessionUiAvailable(
        JSON.stringify({
          type: "runtime.session.ui-available",
          browserUrl: "http://127.0.0.1:4096/L3JlcG8/session/ses_123",
        }),
      ),
    ).toThrow("Invalid runtime session UI message");
  });
});
