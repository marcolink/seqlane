// @test-scope ./session-ui-diagnostic.ts ./commands/run.ts ./run-operational-host.ts

import { describe, expect, it, vi } from "vitest";
import { writeSessionUiDiagnostic } from "./session-ui-diagnostic.js";

describe("session UI diagnostics", () => {
  it("normalizes, redacts, and encodes an untrusted browser URL", () => {
    const write = vi.fn();
    writeSessionUiDiagnostic(
      { stderr: { write }, redactions: ["secret"] },
      "http://host/sec\u001b[31mret\r\n\u0007\u0085\u202e",
    );

    expect(write).toHaveBeenCalledOnce();
    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain("Seqlane session UI: http://host/***");
    expect(output).toContain("\\u000d\\u000a\\u0007\\u0085\\u202e");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("\u001b");
    expect(output.endsWith("\n")).toBe(true);
  });
});
