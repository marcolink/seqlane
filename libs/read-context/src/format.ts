import type { ReadContextResult } from "./schemas.js";

export function formatReadContextMarkdown(result: ReadContextResult): string {
  const evidence =
    result.evidence.length === 0
      ? "- None"
      : result.evidence
          .map((item) => {
            const range =
              item.startLine === undefined
                ? ""
                : `:${item.startLine}-${item.endLine ?? item.startLine}`;
            return `- \`${item.path}${range}\` — ${item.relevance}`;
          })
          .join("\n");
  const relationships =
    result.relationships.length === 0
      ? "- None"
      : result.relationships
          .map((item) => `- \`${item.from}\` → \`${item.to}\` (${item.kind})`)
          .join("\n");
  const followUps =
    result.followUpReads.length === 0
      ? "- None"
      : result.followUpReads
          .map(
            (item) =>
              `- \`${item.path}:${item.startLine}-${item.endLine}\` — ${item.reason}`,
          )
          .join("\n");
  const uncertainties =
    result.uncertainties.length === 0
      ? ""
      : `\n\n## Uncertainties\n\n${result.uncertainties.map((item) => `- ${item}`).join("\n")}`;
  const retrievalNote =
    result.retrieval.excludedPaths.length > 0
      ? `\n\n> Retrieval note: ${result.retrieval.excludedPaths.length} path(s) were bounded or excluded.`
      : "";
  return `## Answer\n\n${result.answer}\n\n## Evidence\n\n${evidence}\n\n## Relationships\n\n${relationships}\n\n## Suggested targeted reads\n\n${followUps}${uncertainties}${retrievalNote}`;
}
