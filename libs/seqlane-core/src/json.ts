import { z } from "zod";
import type { JsonValue } from "./contracts.js";

/**
 * Zod's object schemas read properties during parsing. This shape schema keeps
 * the existing JSON contract for plain records: own enumerable data
 * properties, no symbols, and only Object.prototype or null as the prototype.
 */
export const plainRecordSchema = z.custom<Record<string, unknown>>((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return false;
    }

    return true;
  } catch {
    return false;
  }
});

const jsonArrayShapeSchema = z.custom<readonly unknown[]>((value) => {
  if (!Array.isArray(value)) return false;

  try {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) return false;
    }

    for (const key of Reflect.ownKeys(value)) {
      if (
        key === "length" ||
        (typeof key === "string" &&
          /^0$|^[1-9]\d*$/.test(key) &&
          Number(key) < value.length)
      ) {
        continue;
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
});

export const acyclicValueSchema = z.custom<unknown>((value) => {
  const ancestors = new Set<object>();

  const visit = (candidate: unknown): boolean => {
    if (typeof candidate !== "object" || candidate === null) return true;
    if (ancestors.has(candidate)) return false;

    ancestors.add(candidate);
    try {
      for (const key of Reflect.ownKeys(candidate)) {
        if (Array.isArray(candidate) && key === "length") continue;

        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor && "value" in descriptor && !visit(descriptor.value)) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      ancestors.delete(candidate);
    }
  };

  return visit(value);
});

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  acyclicValueSchema.pipe(
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      jsonArrayShapeSchema.pipe(z.array(jsonValueSchema)),
      plainRecordSchema.pipe(z.record(z.string(), jsonValueSchema)),
    ]),
  ),
);

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  try {
    return plainRecordSchema.safeParse(value).success;
  } catch {
    return false;
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    return jsonValueSchema.safeParse(value).success;
  } catch {
    return false;
  }
}
