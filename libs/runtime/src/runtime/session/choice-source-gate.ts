import type { InvocationId, SeqlaneEvent } from "@seqlane/core";

/** Waits for a selected choice arm's session source without gating the choice graph. */
export class ChoiceSourceGate {
  private readonly sourceByInvocation = new Map<InvocationId, string>();
  private readonly states = new Map<string, boolean>();
  private readonly listeners = new Map<
    string,
    Set<(succeeded: boolean) => void>
  >();

  register(sourceNodeId: string, invocationId: InvocationId): void {
    this.sourceByInvocation.set(invocationId, sourceNodeId);
  }

  observe(event: SeqlaneEvent): void {
    if (
      event.type !== "invocation.succeeded" &&
      event.type !== "invocation.failed" &&
      event.type !== "invocation.skipped" &&
      event.type !== "invocation.cancelled"
    )
      return;
    if (
      event.type === "invocation.failed" &&
      event.disposition === "retry_scheduled"
    )
      return;
    const source = this.sourceByInvocation.get(event.invocationId);
    if (source === undefined) return;
    const succeeded = event.type === "invocation.succeeded";
    this.states.set(source, succeeded);
    for (const listener of this.listeners.get(source) ?? [])
      listener(succeeded);
    this.listeners.delete(source);
  }

  async wait(sourceNodeId: string, signal: AbortSignal): Promise<void> {
    if (!this.sourceByInvocationHas(sourceNodeId)) {
      throw new Error(`No registered choice session source "${sourceNodeId}"`);
    }
    const settled = this.states.get(sourceNodeId);
    if (settled !== undefined) {
      if (!settled)
        throw new Error(
          `Choice session source "${sourceNodeId}" did not succeed`,
        );
      return;
    }
    if (signal.aborted) throw signal.reason ?? new Error("Choice cancelled");
    const succeeded = await new Promise<boolean>((resolve, reject) => {
      const listeners = this.listeners.get(sourceNodeId) ?? new Set();
      const onSettled = (value: boolean): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = (): void => {
        listeners.delete(onSettled);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason ?? new Error("Choice cancelled"));
      };
      listeners.add(onSettled);
      this.listeners.set(sourceNodeId, listeners);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    if (!succeeded)
      throw new Error(
        `Choice session source "${sourceNodeId}" did not succeed`,
      );
  }

  private sourceByInvocationHas(sourceNodeId: string): boolean {
    for (const source of this.sourceByInvocation.values()) {
      if (source === sourceNodeId) return true;
    }
    return false;
  }
}
