import { describe, expect, it } from "vitest";
import {
  buildIndexArguments,
  buildZvecCommandPlan,
  buildZvecEnvironment,
} from "./commands.js";

describe("zvec-grep command plan", () => {
  it("constructs the exact resolve, index, server, and readiness order", () => {
    const plan = buildZvecCommandPlan({
      packageSpec: "@zvec/zvec-grep@0.2.1",
      projectDirectory: "/workspace/review-target",
      listen: "127.0.0.1:7999",
      home: "/tmp/zvec-grep",
    });

    expect(plan.map(({ phase }) => phase)).toEqual([
      "resolve",
      "index",
      "server",
      "readiness",
    ]);
    expect(plan[0]?.args).toEqual(["dlx", "@zvec/zvec-grep@0.2.1", "version"]);
    expect(plan[1]?.args).toEqual([
      "dlx",
      "@zvec/zvec-grep@0.2.1",
      "index",
      "/workspace/review-target",
      "--mode",
      "direct",
      "--embedding",
      "local/potion-code-16m-v2",
      "--hidden",
      "--max-filesize",
      "1M",
      "--glob",
      "*.ts",
      "--glob",
      "*.tsx",
      "--glob",
      "*.mts",
      "--glob",
      "*.cts",
      "--glob",
      "*.js",
      "--glob",
      "*.jsx",
      "--glob",
      "*.json",
      "--glob",
      "*.yaml",
      "--glob",
      "*.yml",
      "--glob",
      "*.md",
      "--glob",
      "*.css",
      "--glob",
      "*.html",
      "--glob",
      "*.sh",
      "--glob",
      ".github/**",
      "--glob",
      "!**/node_modules/**",
      "--glob",
      "!**/dist/**",
      "--glob",
      "!**/build/**",
      "--glob",
      "!**/coverage/**",
      "--glob",
      "!**/.cache/**",
      "--glob",
      "!**/.next/**",
      "--glob",
      "!**/vendor/**",
      "--glob",
      "!**/.env",
      "--glob",
      "!**/.env.*",
      "--glob",
      "!**/.envrc",
      "--glob",
      "!**/.npmrc",
      "--glob",
      "!**/id_*",
      "--glob",
      "!**/*.pem",
      "--glob",
      "!**/*.key",
      "--glob",
      "!**/*.p12",
      "--glob",
      "!**/*.pfx",
      "--glob",
      "!**/secrets/**",
      "--glob",
      "!**/private/**",
      "--glob",
      "!**/credentials/**",
      "--glob",
      "!**/*secret*.json",
      "--glob",
      "!**/*credential*.json",
    ]);
    expect(plan[2]?.args).toEqual([
      "dlx",
      "@zvec/zvec-grep@0.2.1",
      "server",
      "run",
      "--listen",
      "127.0.0.1:7999",
    ]);
    expect(plan[3]?.args).toEqual([
      "dlx",
      "@zvec/zvec-grep@0.2.1",
      "server",
      "status",
      "--check-ready",
      "--home",
      "/tmp/zvec-grep",
    ]);
  });

  it("propagates the configured home and model cache", () => {
    expect(
      buildZvecEnvironment(
        { PATH: "/bin", ZVEC_GREP_HOME: "old" },
        "/tmp/zvec-grep",
        "/tmp/zvec-model-cache",
      ),
    ).toEqual({
      PATH: "/bin",
      ZVEC_GREP_HOME: "/tmp/zvec-grep",
      ZVEC_GREP_MODEL_CACHE: "/tmp/zvec-model-cache",
    });
  });

  it("passes configured index options and appends additional globs before exclusions", () => {
    const args = buildIndexArguments(
      "@zvec/zvec-grep@0.2.1",
      "/workspace/review-target",
      {
        embedding: "custom/model",
        maxFilesize: "2M",
        additionalGlobs: ["*.py", "src/**"],
      },
    );

    expect(args).toEqual(
      expect.arrayContaining([
        "--mode",
        "direct",
        "--embedding",
        "custom/model",
        "--max-filesize",
        "2M",
      ]),
    );
    const pyIndex = args.indexOf("*.py");
    const sourceIndex = args.indexOf("src/**");
    const exclusionIndex = args.indexOf("!**/node_modules/**");
    expect(pyIndex).toBeGreaterThan(-1);
    expect(sourceIndex).toBeGreaterThan(pyIndex);
    expect(exclusionIndex).toBeGreaterThan(sourceIndex);
  });

  it("keeps immutable exclusions after an additional glob", () => {
    const args = buildIndexArguments("@zvec/zvec-grep@0.2.1", "/workspace", {
      additionalGlobs: ["*.py"],
    });

    expect(args.indexOf("*.py")).toBeGreaterThan(-1);
    expect(args.indexOf("!**/private/**")).toBeGreaterThan(
      args.indexOf("*.py"),
    );
  });

  it("omits the model cache environment variable when disabled", () => {
    expect(
      buildZvecEnvironment(
        { PATH: "/bin", ZVEC_GREP_MODEL_CACHE: "old" },
        "/tmp/zvec-grep",
        undefined,
      ),
    ).toEqual({
      PATH: "/bin",
      ZVEC_GREP_HOME: "/tmp/zvec-grep",
    });
  });
});
