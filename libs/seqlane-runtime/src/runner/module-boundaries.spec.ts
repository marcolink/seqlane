// @test-scope ./main.ts
// @test-scope ./run.ts
import { describe, expect, it } from "vitest";
import * as main from "./main.js";
import * as run from "./run.js";

describe("runner module boundaries", () => {
  it("keeps process startup separate from one-run orchestration", () => {
    expect(main.startRunnerProcess).toEqual(expect.any(Function));
    expect(main).not.toHaveProperty("startRun");
    expect(run.startRun).toEqual(expect.any(Function));
  });
});
