import { isJsonValue, type JsonValue } from "@seqlane/core";

const inputFlagPrefix = "--input.";
const maxInputPathSegments = 64;

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

type InputObjectNode = {
  readonly kind: "object";
  readonly children: Map<string, InputNode>;
};

type InputValueNode = {
  readonly kind: "value";
  readonly value: JsonValue;
};

type InputNode = InputObjectNode | InputValueNode;

function parseInputValue(value: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isJsonValue(parsed)) return parsed;
  } catch {
    // Plain, non-JSON values are strings.
  }
  return value;
}

function toJsonValue(node: InputNode): JsonValue {
  if (node.kind === "value") return node.value;

  const value: { [key: string]: JsonValue } = {};
  for (const [key, child] of node.children) {
    Object.defineProperty(value, key, {
      configurable: true,
      enumerable: true,
      value: toJsonValue(child),
      writable: true,
    });
  }
  return value;
}

export function parseDottedInputParameters(
  parameters: readonly string[],
): JsonValue {
  const root: InputObjectNode = { kind: "object", children: new Map() };

  for (const parameter of parameters) {
    const equalsIndex = parameter.indexOf("=");
    if (equalsIndex < 1) {
      throw new Error("--input.<path> requires a field path and value");
    }

    const path = parameter.slice(0, equalsIndex);
    const segments = path.split(".");
    if (segments.some((segment) => segment.length === 0)) {
      throw new Error("--input.<path> must not contain empty path segments");
    }
    if (segments.length > maxInputPathSegments) {
      throw new Error(
        `--input.<path> can have at most ${maxInputPathSegments} segments`,
      );
    }

    let node = root;
    for (const [index, segment] of segments.entries()) {
      const isLeaf = index === segments.length - 1;
      const existing = node.children.get(segment);

      if (isLeaf) {
        if (existing?.kind === "value") {
          throw new Error(`duplicate --input.${path} field`);
        }
        if (existing !== undefined) {
          throw new Error(`conflicting --input.${path} field path`);
        }
        node.children.set(segment, {
          kind: "value",
          value: parseInputValue(parameter.slice(equalsIndex + 1)),
        });
        continue;
      }

      if (existing?.kind === "value") {
        throw new Error(`conflicting --input.${path} field path`);
      }
      if (existing === undefined) {
        const child: InputObjectNode = {
          kind: "object",
          children: new Map(),
        };
        node.children.set(segment, child);
        node = child;
      } else {
        node = existing;
      }
    }
  }

  return toJsonValue(root);
}
