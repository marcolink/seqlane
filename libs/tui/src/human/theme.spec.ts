import { describe, expect, it } from "vitest";
import { activityTone, workTone } from "./theme.js";

describe("workTone", () => {
  it.each([
    ["workflow", "blue", "blueBright"],
    ["task", "cyan", "cyanBright"],
    ["validation", "magenta", "magentaBright"],
    ["loop", "yellow", "yellowBright"],
  ] as const)(
    "keeps %s hue stable while emphasizing running work",
    (kind, base, bright) => {
      expect(workTone(kind, "active", true)).toEqual({
        color: bright,
        bold: false,
        dimColor: false,
      });
      for (const state of [
        "queued",
        "waiting",
        "succeeded",
        "skipped",
      ] as const) {
        expect(workTone(kind, state, true)).toEqual({
          color: base,
          bold: false,
          dimColor: true,
        });
      }
    },
  );

  it.each(["failed", "retrying"] as const)(
    "does not dim %s work that needs attention",
    (state) => {
      expect(workTone("task", state, true).dimColor).toBe(false);
    },
  );

  it.each(["active", "succeeded", "failed", "queued"] as const)(
    "disables styling for %s work without ANSI",
    (state) => {
      expect(workTone("task", state, false)).toEqual({
        color: undefined,
        bold: false,
        dimColor: false,
      });
    },
  );
});

describe("activityTone", () => {
  it("uses distinct tool and skill colors with a no-color fallback", () => {
    expect(activityTone("tool", true)).toEqual({
      color: "cyan",
      bold: false,
    });
    expect(activityTone("skill", true)).toEqual({
      color: "magenta",
      bold: false,
    });
    expect(activityTone("tool", false)).toEqual({
      color: undefined,
      bold: false,
    });
  });
});
