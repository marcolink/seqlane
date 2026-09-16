import { stripVTControlCharacters } from "node:util";

const UNSAFE_CONTROL_SOURCE =
  "[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]";
const UNSAFE_CONTROL_PATTERN = new RegExp(UNSAFE_CONTROL_SOURCE, "gu");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function redactAcrossControls(
  value: string,
  redactions: readonly string[],
): string {
  return [...new Set(redactions)]
    .map((secret) =>
      stripVTControlCharacters(secret).replace(UNSAFE_CONTROL_PATTERN, ""),
    )
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, secret) => {
      const pattern = [...secret]
        .map(escapeRegExp)
        .join(`${UNSAFE_CONTROL_SOURCE}*`);
      return redacted.replace(new RegExp(pattern, "gu"), "***");
    }, value);
}

/** Dynamic fields are single-line data, never terminal instructions. */
export function encodeTerminalField(
  value: string,
  redactions: readonly string[] = [],
): string {
  const normalized = stripVTControlCharacters(value);
  const normalizedRedactions = redactions.map((redaction) =>
    stripVTControlCharacters(redaction),
  );
  const plain = redactAcrossControls(normalized, normalizedRedactions);
  // Explicitly encode C0/C1 and bidi/line controls not removed by ANSI stripping.
  return plain.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
