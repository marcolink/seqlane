import { z } from "zod";
import { ClassifierFailure, type ClassifierFailureCode } from "./types.js";

export const CLASSIFIER_MAX_BODY_BYTES = 1024 * 1024;
export const CLASSIFIER_MAX_STATE_BYTES = 768 * 1024;
export const CLASSIFIER_MAX_CONTAINER_DEPTH = 64;
export const CLASSIFIER_MAX_OBJECT_ENTRIES = 8_192;
export const CLASSIFIER_MAX_ARRAY_ENTRIES = 16_384;
export const CLASSIFIER_MAX_JSON_VALUES_AND_ENTRIES = 65_536;
export const CLASSIFIER_MAX_STRING_BYTES = 256 * 1024;
export const CLASSIFIER_MAX_INSTRUCTIONS_BYTES = 64 * 1024;
export const CLASSIFIER_MAX_DESCRIPTION_BYTES = 16 * 1024;

interface JsonFrame {
  readonly value: unknown;
  readonly depth: number;
  readonly exit?: object;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function inspectJson(value: unknown): void {
  const pending: JsonFrame[] = [{ value, depth: 1 }];
  const ancestors = new Set<object>();
  let total = 0;

  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) break;
    if (frame.exit !== undefined) {
      ancestors.delete(frame.exit);
      continue;
    }
    total += 1;
    if (total > CLASSIFIER_MAX_JSON_VALUES_AND_ENTRIES) throw new Error();
    const candidate = frame.value;
    if (candidate === null || typeof candidate === "boolean") continue;
    if (typeof candidate === "string") {
      if (utf8Bytes(candidate) > CLASSIFIER_MAX_STRING_BYTES) throw new Error();
      continue;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error();
      continue;
    }
    if (typeof candidate !== "object") throw new Error();
    if (frame.depth > CLASSIFIER_MAX_CONTAINER_DEPTH) throw new Error();
    if (ancestors.has(candidate)) throw new Error();
    ancestors.add(candidate);
    pending.push({ value: null, depth: frame.depth, exit: candidate });

    let entries: readonly (readonly [string, unknown])[];
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > CLASSIFIER_MAX_ARRAY_ENTRIES) throw new Error();
        const values: [string, unknown][] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            candidate,
            String(index),
          );
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          ) {
            throw new Error();
          }
          values.push([String(index), descriptor.value]);
        }
        for (const key of Reflect.ownKeys(candidate)) {
          if (
            key !== "length" &&
            !(
              typeof key === "string" &&
              /^(?:0|[1-9]\d*)$/.test(key) &&
              Number(key) < candidate.length
            )
          ) {
            throw new Error();
          }
        }
        entries = values;
      } else {
        const prototype = Object.getPrototypeOf(candidate);
        if (prototype !== Object.prototype && prototype !== null)
          throw new Error();
        const keys = Reflect.ownKeys(candidate);
        if (keys.length > CLASSIFIER_MAX_OBJECT_ENTRIES) throw new Error();
        const values: [string, unknown][] = [];
        for (const key of keys) {
          if (
            typeof key !== "string" ||
            utf8Bytes(key) > CLASSIFIER_MAX_STRING_BYTES
          ) {
            throw new Error();
          }
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          ) {
            throw new Error();
          }
          values.push([key, descriptor.value]);
        }
        entries = values;
      }
    } catch {
      throw new Error();
    }

    total += entries.length;
    if (total > CLASSIFIER_MAX_JSON_VALUES_AND_ENTRIES) throw new Error();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry !== undefined) {
        pending.push({ value: entry[1], depth: frame.depth + 1 });
      }
    }
  }
}

/** Iterative preflight runs before any recursive contract schema. */
export function boundedJsonPreflightSchema(
  message: string,
): z.ZodType<unknown> {
  return z.custom<unknown>((value) => {
    try {
      inspectJson(value);
      return true;
    } catch {
      return false;
    }
  }, message);
}

export function parseBoundedJson(
  value: unknown,
  label: string,
  code: Extract<ClassifierFailureCode, "request" | "response">,
): unknown {
  const message = `Classifier ${label} exceeds the safe JSON limits`;
  const parsed = boundedJsonPreflightSchema(message).safeParse(value);
  if (!parsed.success) throw new ClassifierFailure(code, message);
  return parsed.data;
}

function boundedSerializedJsonSchema(
  maximumBytes: number,
  message: string,
): z.ZodType<unknown> {
  return z.custom<unknown>((value) => {
    try {
      inspectJson(value);
      const serialized = JSON.stringify(value);
      if (
        serialized !== undefined &&
        Buffer.byteLength(serialized, "utf8") <= maximumBytes
      ) {
        return true;
      }
    } catch {
      // The schema reports one bounded payload failure to callers.
    }
    return false;
  }, message);
}

export function serializeBoundedJson(
  value: unknown,
  label: string,
  maximumBytes = CLASSIFIER_MAX_BODY_BYTES,
): string {
  const code: Extract<ClassifierFailureCode, "request" | "response"> =
    label === "response" ? "response" : "request";
  const message = `Classifier ${label} exceeds the byte or JSON safety limit`;
  const parsed = boundedSerializedJsonSchema(maximumBytes, message).safeParse(
    value,
  );
  if (!parsed.success) throw new ClassifierFailure(code, message);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ClassifierFailure(code, `Classifier ${label} is not valid JSON`);
  }
  if (serialized === undefined) {
    throw new ClassifierFailure(code, `Classifier ${label} is not valid JSON`);
  }
  return serialized;
}
