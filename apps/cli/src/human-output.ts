export function escapeTerminalText(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      if (code > 0x1f && (code < 0x7f || code > 0x9f)) return character;
      if (character === "\n") return "\\n";
      if (character === "\r") return "\\r";
      if (character === "\t") return "\\t";
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    })
    .join("");
}
