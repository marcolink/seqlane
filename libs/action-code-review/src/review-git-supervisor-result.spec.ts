import { describe, expect, it } from "vitest";
import { parseReviewGitSupervisorResult } from "./review-git-supervisor-result.js";

const valid = {
  kind: "ok",
  exitCode: 0,
  stdout: "YWJjAA==",
  stderr: "",
  usage: { wallMs: 1.5, cpuMs: 0.75, peakMemoryBytes: 4096, transferBytes: 0 },
};
const parse = (value: unknown) =>
  parseReviewGitSupervisorResult(
    Buffer.from(JSON.stringify(value)),
    "local-git",
  );
describe("Git supervisor result boundary", () => {
  it("preserves raw NUL bytes and measured accounting", () => {
    const result = parse(valid);
    expect(Buffer.from(result.stdout)).toEqual(Buffer.from([97, 98, 99, 0]));
    expect(result.usage).toEqual(valid.usage);
    expect(result.stdoutTruncated).toBe(false);
  });
  it.each([
    { ...valid, usage: { wallMs: 1, cpuMs: 1, transferBytes: 0 } },
    { ...valid, usage: { ...valid.usage, cpuMs: -1 } },
    { ...valid, stdout: "YWJj==" },
    { ...valid, stdoutTruncated: true },
  ])("rejects missing or malformed measurements and output", (value) => {
    expect(() => parse(value)).toThrowError(/malformed accounting/);
  });
  it("retains the supervisor's actual limit identity", () => {
    expect(() =>
      parse({
        kind: "limit",
        resource: "outputBytes",
        observed: 65,
        limit: 64,
      }),
    ).toThrowError(
      expect.objectContaining({
        resource: "outputBytes",
        observed: 65,
        limit: 64,
        operation: "local-git",
      }),
    );
  });
});
