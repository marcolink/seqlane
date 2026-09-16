import { expect, it, vi } from "vitest";
import { HumanTTYRenderer } from "./human-renderer.js";
const mounted = vi.hoisted(() => ({
  rerender: vi.fn(),
  finish: vi.fn(async () => undefined),
}));
vi.mock("./human/app.js", () => ({ mountHumanApp: vi.fn(() => mounted) }));

it("routes failures through Ink instead of writing outside the live frame", async () => {
  const stderr = { write: vi.fn() };
  const renderer = new HumanTTYRenderer({
    isTTY: true,
    hasTerminalInput: true,
    width: 80,
    supportsAnsi: false,
    supportsUnicode: true,
    stdout: { write: vi.fn() },
    stderr,
    terminal: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    },
  });
  renderer.handleRunnerFailure({ message: "failure\u001b[2J\r\nsecret" });
  await renderer.finish();
  expect(stderr.write).not.toHaveBeenCalled();
  expect(mounted.rerender).toHaveBeenCalledWith(
    expect.objectContaining({
      view: expect.objectContaining({
        runState: "failed",
        runError: expect.objectContaining({
          message: "failure\u001b[2J\r\nsecret",
        }),
      }),
    }),
  );
});

it("rejects human rendering without terminal input", () => {
  expect(
    () =>
      new HumanTTYRenderer({
        isTTY: true,
        hasTerminalInput: false,
        width: 80,
        supportsAnsi: true,
        supportsUnicode: true,
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
      }),
  ).toThrow("Human output requires terminal input and output");
});
