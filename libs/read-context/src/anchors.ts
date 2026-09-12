export type ExactAnchorKind = "quoted" | "path" | "config" | "identifier";

export interface ExactAnchor {
  value: string;
  kind: ExactAnchorKind;
}

const commonWords = new Set([
  "about",
  "after",
  "answer",
  "configured",
  "context",
  "from",
  "how",
  "into",
  "only",
  "reach",
  "settings",
  "source",
  "that",
  "the",
  "this",
  "trace",
  "what",
  "where",
  "which",
]);

function addAnchor(
  anchors: Map<string, ExactAnchor>,
  value: string,
  kind: ExactAnchorKind,
): void {
  const normalized = value.trim();
  if (normalized.length < 2 || normalized.length > 200) return;
  if (!anchors.has(normalized))
    anchors.set(normalized, { value: normalized, kind });
}

export function extractExactAnchors(
  question: string,
  paths: readonly string[] = [],
): ExactAnchor[] {
  const anchors = new Map<string, ExactAnchor>();

  for (const match of question.matchAll(/(["'])(.{2,200}?)\1/g)) {
    const value = match[2];
    if (value !== undefined) addAnchor(anchors, value, "quoted");
  }

  for (const path of paths) {
    const normalized = path.trim();
    if (normalized.length > 1) {
      addAnchor(anchors, normalized, "path");
      const fileName = normalized.split(/[\\/]/).at(-1);
      if (fileName !== undefined) addAnchor(anchors, fileName, "path");
    }
  }

  for (const rawToken of question.matchAll(/[A-Za-z0-9_./-]{2,200}/g)) {
    const token = rawToken[0];
    if (token === undefined || commonWords.has(token.toLowerCase())) continue;
    if (token.includes("/") || /\.[A-Za-z][A-Za-z0-9_-]*$/.test(token)) {
      addAnchor(anchors, token, "path");
      continue;
    }
    if (token.includes(".") || token.includes("_") || /[A-Z]/.test(token)) {
      addAnchor(anchors, token, "config");
      continue;
    }
    if (/[0-9]/.test(token) && token.length >= 3) {
      addAnchor(anchors, token, "identifier");
    }
  }

  return [...anchors.values()].slice(0, 24);
}
