const inputFlagPrefix = "--input.";

export function findDottedInputFlagMissingValue(
  argv: readonly string[],
): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") return undefined;
    if (!argument.startsWith(inputFlagPrefix) || argument.includes("=")) {
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value === "--" || value.startsWith("--")) {
      return argument;
    }
    index += 1;
  }

  return undefined;
}

export function rewriteDottedInputFlags(argv: readonly string[]): string[] {
  const rewritten: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      rewritten.push(...argv.slice(index));
      break;
    }
    if (!argument.startsWith(inputFlagPrefix)) {
      rewritten.push(argument);
      continue;
    }

    const assignment = argument.slice(inputFlagPrefix.length);
    const equalsIndex = assignment.indexOf("=");
    const path =
      equalsIndex < 0 ? assignment : assignment.slice(0, equalsIndex);
    if (equalsIndex >= 0) {
      rewritten.push(
        "--input-param",
        `${path}=${assignment.slice(equalsIndex + 1)}`,
      );
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value === "--" || value.startsWith("--")) {
      // Leave a value-less internal flag for Oclif to report as a parse error.
      rewritten.push("--input-param");
      continue;
    }

    index += 1;
    rewritten.push("--input-param", `${path}=${value}`);
  }

  return rewritten;
}
