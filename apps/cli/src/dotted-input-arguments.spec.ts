// @test-scope ./dotted-input-arguments.ts

import { describe, expect, it } from "vitest";
import {
  findDottedInputFlagMissingValue,
  rewriteDottedInputFlags,
} from "./dotted-input-arguments.js";

describe("dotted input argv normalization", () => {
  it("rewrites separate and equals syntax into repeatable Oclif flags", () => {
    expect(
      rewriteDottedInputFlags([
        "./workflow.ts",
        "--input.name",
        "Marco",
        "--input.count=42",
        "--dry",
      ]),
    ).toEqual([
      "./workflow.ts",
      "--input-param",
      "name=Marco",
      "--input-param",
      "count=42",
      "--dry",
    ]);
  });

  it("leaves arguments after the end-of-options marker unchanged", () => {
    expect(
      rewriteDottedInputFlags([
        "--input.name",
        "Marco",
        "--",
        "--input.ignored=value",
      ]),
    ).toEqual(["--input-param", "name=Marco", "--", "--input.ignored=value"]);
  });

  it("finds missing values without reading flags after the end marker", () => {
    expect(findDottedInputFlagMissingValue(["--input.name", "--dry"])).toBe(
      "--input.name",
    );
    expect(
      findDottedInputFlagMissingValue(["--", "--input.name"]),
    ).toBeUndefined();
    expect(
      findDottedInputFlagMissingValue(["--input.name", "Marco"]),
    ).toBeUndefined();
  });
});
