import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserInputView } from "../renderer-contract.js";
import { UserInputForm } from "./user-input-form.js";

afterEach(cleanup);
function input(): UserInputView {
  return {
    requestId: "request",
    invocationId: "invocation",
    pendingCount: 2,
    submitting: false,
    questions: [
      {
        id: "region",
        prompt: "Choose region",
        options: [{ value: "eu", label: "Europe" }],
        allowFreeText: false,
      },
      { id: "note", prompt: "Note", allowFreeText: true },
    ],
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
  };
}
describe("user input form", () => {
  it("validates choices, preserves text, submits a batch, and releases keys", async () => {
    const state = input();
    const ui = render(<UserInputForm input={state} />);
    await vi.waitFor(() =>
      expect(ui.stdin.listenerCount("readable")).toBeGreaterThan(0),
    );
    expect(ui.lastFrame()).toContain("2 pending");
    ui.stdin.write("9");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("9▌"));
    ui.stdin.write("\r");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("valid answer"));
    ui.stdin.write("\u007f");
    ui.stdin.write("1");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("1▌"));
    ui.stdin.write("\r");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("2/2: Note"));
    ui.stdin.write("  exact text\nnext line  ");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("exact text"));
    ui.stdin.write("\r");
    await vi.waitFor(() =>
      expect(state.onSubmit).toHaveBeenCalledWith({
        region: "eu",
        note: "  exact text\nnext line  ",
      }),
    );
    ui.unmount();
    expect(ui.stdin.listenerCount("readable")).toBe(0);
  });
  it.each(["\u001b", "\u0003", "\u0004"])(
    "cancels on control %j",
    async (key) => {
      const state = input();
      const ui = render(<UserInputForm input={state} />);
      await vi.waitFor(() =>
        expect(ui.stdin.listenerCount("readable")).toBeGreaterThan(0),
      );
      ui.stdin.write(key);
      await vi.waitFor(() => expect(state.onCancel).toHaveBeenCalledOnce());
    },
  );
  it("renders untrusted prompts and labels as terminal data", () => {
    const state = input();
    const ui = render(
      <UserInputForm
        input={{
          ...state,
          questions: [
            { id: "x", prompt: "\u001b[31msecret\u202e", allowFreeText: true },
          ],
        }}
        redactions={["secret"]}
      />,
    );
    expect(ui.lastFrame()).toContain("***\\u202e");
    expect(ui.lastFrame()).not.toContain("secret");
  });
});
