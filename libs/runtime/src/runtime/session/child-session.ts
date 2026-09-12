import type { InvocationId } from "@seqlane/core";

export interface ChildSession {
  readonly key: symbol;
  readonly parentInvocationId: InvocationId;
}

export interface RegisteredChildSession {
  readonly child: ChildSession;
  readonly termination: Promise<unknown>;
}

/** Keeps executor-private child sessions associated with their parent invocation. */
export class ChildSessionRegistry {
  readonly #activeChildren = new Map<symbol, InvocationId>();

  register(
    parentInvocationId: InvocationId,
    termination: Promise<unknown>,
  ): RegisteredChildSession {
    const child: ChildSession = {
      key: Symbol("child-executor-session"),
      parentInvocationId,
    };
    this.#activeChildren.set(child.key, parentInvocationId);
    return {
      child,
      termination: Promise.resolve(termination).then(
        (value) => {
          this.#activeChildren.delete(child.key);
          return value;
        },
        (cause: unknown) => {
          this.#activeChildren.delete(child.key);
          throw cause;
        },
      ),
    };
  }

  parentInvocationIds(): readonly InvocationId[] {
    return [...new Set(this.#activeChildren.values())];
  }

  parentInvocationFor(child: ChildSession): InvocationId | undefined {
    return this.#activeChildren.get(child.key);
  }
}
