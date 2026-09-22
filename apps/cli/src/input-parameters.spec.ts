// @test-scope ./input-parameters.ts

import { describe, expect, it } from "vitest";
import { parseDottedInputParameters } from "./input-parameters.js";

describe("dotted workflow input flags", () => {
  it("builds nested objects and infers JSON value types", () => {
    expect(
      parseDottedInputParameters([
        "name=Marco",
        "profile.age=42",
        "profile.active=true",
        'tags=["cli","workflow"]',
        'profile.label="true"',
        "note=--draft",
      ]),
    ).toEqual({
      name: "Marco",
      profile: { age: 42, active: true, label: "true" },
      tags: ["cli", "workflow"],
      note: "--draft",
    });
  });

  it("rejects duplicate and parent/child paths", () => {
    expect(() =>
      parseDottedInputParameters(["name=Marco", "name=Ana"]),
    ).toThrow("duplicate --input.name field");
    expect(() =>
      parseDottedInputParameters(["profile=Marco", "profile.name=Ana"]),
    ).toThrow("conflicting --input.profile.name field path");
    expect(() =>
      parseDottedInputParameters(["profile.name=Ana", "profile=Marco"]),
    ).toThrow("conflicting --input.profile field path");
  });

  it("rejects empty path segments and paths deeper than 64 fields", () => {
    expect(() => parseDottedInputParameters(["profile..name=Marco"])).toThrow(
      "must not contain empty path segments",
    );
    expect(() =>
      parseDottedInputParameters([
        `${Array.from({ length: 64 }, () => "a").join(".")}=x`,
      ]),
    ).not.toThrow();
    expect(() =>
      parseDottedInputParameters([
        `${Array.from({ length: 65 }, () => "a").join(".")}=x`,
      ]),
    ).toThrow("at most 64 segments");
  });
});
