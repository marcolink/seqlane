// @test-scope ./classifier-environment.ts

import { describe, expect, it } from "vitest";
import {
  classifierApiKeyEnvironment,
  classifierModelEnvironment,
  classifierUrlEnvironment,
  createClassifierStartupEnvironment,
  parseClassifierCliOptions,
} from "./classifier-environment.js";

describe("classifier runner environment", () => {
  it("passes only the selected endpoint and model as startup values", () => {
    const childEnvironment = createClassifierStartupEnvironment(
      {
        PATH: "/usr/bin",
        [classifierUrlEnvironment]: "https://inherited.example/classify",
        [classifierModelEnvironment]: "inherited-model",
        [classifierApiKeyEnvironment]: "private-token",
      },
      "https://selected.example/v1/systemone",
      "jev-latest",
    );

    expect(childEnvironment).toEqual({
      PATH: "/usr/bin",
      [classifierUrlEnvironment]: "https://selected.example/v1/systemone",
      [classifierModelEnvironment]: "jev-latest",
      [classifierApiKeyEnvironment]: "private-token",
    });
  });

  it("drops inherited endpoint and model when CLI flags are absent", () => {
    const childEnvironment = createClassifierStartupEnvironment(
      {
        [classifierUrlEnvironment]: "https://inherited.example/classify",
        [classifierModelEnvironment]: "inherited-model",
        [classifierApiKeyEnvironment]: "private-token",
      },
      undefined,
      undefined,
    );

    expect(childEnvironment).toEqual({
      [classifierApiKeyEnvironment]: "private-token",
    });
  });

  it("requires both non-empty classifier flags", () => {
    expect(() =>
      parseClassifierCliOptions("https://classifier.example", undefined),
    ).toThrow("--classifier-url and --classifier-model must be used together");
    expect(() => parseClassifierCliOptions(undefined, "jev-latest")).toThrow(
      "--classifier-url and --classifier-model must be used together",
    );
    expect(() => parseClassifierCliOptions("  ", "jev-latest")).toThrow(
      "Classifier URL and model must be non-empty",
    );
  });
});
