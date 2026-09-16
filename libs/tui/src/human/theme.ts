import type { RunNode } from "../run-view-model.js";

/** Hue identifies work type; intensity identifies current execution. */
const TYPE_COLORS = {
  workflow: ["blue", "blueBright"],
  task: ["cyan", "cyanBright"],
  validation: ["magenta", "magentaBright"],
  loop: ["yellow", "yellowBright"],
} as const;

export function workTone(
  kind: RunNode["kind"],
  state: RunNode["state"],
  supportsAnsi: boolean,
) {
  const active = state === "active";
  return {
    color: supportsAnsi ? TYPE_COLORS[kind][active ? 1 : 0] : undefined,
    bold: supportsAnsi && active,
    dimColor:
      supportsAnsi && !active && state !== "failed" && state !== "retrying",
  };
}
