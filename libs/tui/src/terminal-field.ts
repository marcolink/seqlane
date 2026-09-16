import { stripVTControlCharacters } from "node:util";
import { redactOutput } from "./redaction.js";

/** Dynamic fields are single-line data, never terminal instructions. */
export function encodeTerminalField(
  value: string,
  redactions: readonly string[] = [],
): string {
  const plain = stripVTControlCharacters(redactOutput(value, redactions));
  // Explicitly encode C0/C1 and bidi/line controls not removed by ANSI stripping.
  return plain.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
