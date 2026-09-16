import { describe, expect, it } from "vitest";
import { encodeTerminalField } from "./terminal-field.js";

describe("terminal fields", () => {
  it("redacts secrets before encoding and removes terminal commands", () => {
    expect(
      encodeTerminalField("secret\u001b[2J\u001b]0;owned\u0007safe", [
        "secret",
      ]),
    ).toBe("***safe");
  });
  it("redacts a secret split by terminal controls", () => {
    expect(encodeTerminalField("sec\u001b[31mret", ["secret"])).toBe("***");
  });
  it.each(["\n", "\u0085", "\u202e", "\u2066"])(
    "redacts a secret split by encoded control %j",
    (control) => {
      expect(encodeTerminalField(`sec${control}ret`, ["secret"])).toBe("***");
    },
  );
  it.each([
    "\r",
    "\n",
    "\t",
    "\0",
    "\u0007",
    "\u007f",
    "\u0085",
    "\u009b",
    "\u202e",
    "\u2066",
  ])("encodes control %j", (control) => {
    expect(encodeTerminalField(`a${control}b`)).not.toContain(control);
  });
  it("preserves ordinary Unicode text", () => {
    expect(encodeTerminalField("✓ café 日本語")).toBe("✓ café 日本語");
  });
});
