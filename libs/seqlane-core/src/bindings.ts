import type {
  JsonPrimitive,
  PlanNodeId,
  SessionPolicy,
  ValidationResult,
} from "./contracts.js";
import { z } from "zod";

export const valueRefSchema = z.looseObject({
  type: z.literal("ref"),
  nodeId: z.string(),
  path: z.array(z.string()),
});

export type ValueRefData = Pick<
  z.infer<typeof valueRefSchema>,
  "type" | "nodeId" | "path"
> & {
  readonly nodeId: PlanNodeId;
};

type ValueRefProperties<T> = T extends readonly (infer Item)[]
  ? { readonly [index: number]: ValueRef<Item> }
  : T extends object
    ? { readonly [Key in keyof T]-?: ValueRef<T[Key]> }
    : unknown;

export type ValueRef<T = unknown> = ValueRefData & ValueRefProperties<T>;

declare const sessionCheckpointRefBrand: unique symbol;

/** Opaque reference to the stable agent-session checkpoint after a task node. */
export interface SessionCheckpointRef {
  readonly type: "session-checkpoint";
  readonly nodeId: PlanNodeId;
  readonly [sessionCheckpointRefBrand]: undefined;
}

export function createSessionCheckpointRef(
  nodeId: PlanNodeId,
): SessionCheckpointRef {
  return Object.freeze({
    type: "session-checkpoint" as const,
    nodeId,
  }) as SessionCheckpointRef;
}

export function sessionCheckpointNodeId(
  checkpoint: SessionCheckpointRef,
): PlanNodeId {
  return checkpoint.nodeId;
}

export type InputBinding<T> =
  | ValueRef<T>
  | (T extends readonly (infer Item)[]
      ? readonly InputBinding<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: InputBinding<T[Key]> }
        : T);

/** Typed handle returned by a task invocation with a declared session policy. */
export interface TaskInvocationWithSession<Output = unknown> {
  readonly nodeId: PlanNodeId;
  readonly output: ValueRef<Output>;
  readonly session: SessionCheckpointRef;
}

/** Typed handle returned by a task invocation. */
export type TaskInvocation<
  Output = unknown,
  Session extends SessionPolicy | undefined = undefined,
> = Session extends undefined
  ? MechanicalTaskRef<Output>
  : TaskInvocationWithSession<Output>;

/** Typed handle returned by a task invocation without a declared session policy. */
export interface MechanicalTaskRef<Output = unknown> {
  readonly nodeId: PlanNodeId;
  readonly output: ValueRef<Output>;
}

export interface ValidationInvocation<Output = unknown> {
  readonly nodeId: PlanNodeId;
  /** The candidate value represented by the gate. */
  readonly output: ValueRef<Output>;
  /** The structured verdict and evidence. */
  readonly result: ValueRef<ValidationResult>;
}

export type ValueBinding =
  | JsonPrimitive
  | ValueRef
  | readonly ValueBinding[]
  | { readonly [key: string]: ValueBinding };

function createValueRefProxy<T>(
  nodeId: PlanNodeId,
  path: readonly string[],
): ValueRef<T> {
  const target: ValueRefData = {
    type: "ref",
    nodeId,
    path: [...path],
  };

  return new Proxy(target, {
    get(current, property, receiver) {
      if (property === "toJSON") return undefined;
      if (typeof property !== "string") {
        return Reflect.get(current, property, receiver);
      }
      if (Object.hasOwn(current, property)) {
        return Reflect.get(current, property, receiver);
      }
      return createValueRefProxy(nodeId, [...path, property]);
    },
  }) as ValueRef<T>;
}

export function createValueRef<T = unknown>(
  nodeId: PlanNodeId,
  path: readonly string[] = [],
): ValueRef<T> {
  return createValueRefProxy(nodeId, path);
}

export const WORKFLOW_INPUT_NODE_ID = "__seqlane_input";

export function createWorkflowInputRef<T = unknown>(): ValueRef<T> {
  return createValueRef<T>(WORKFLOW_INPUT_NODE_ID);
}

export function serializeBinding(value: unknown): ValueBinding {
  const reference = valueRefSchema.safeParse(value);
  if (reference.success) {
    return {
      type: "ref",
      nodeId: reference.data.nodeId,
      path: [...reference.data.path],
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeBinding(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeBinding(item)]),
    );
  }

  return value as ValueBinding;
}

export function collectDependencies(
  value: unknown,
  dependencies: Set<PlanNodeId>,
): void {
  const reference = valueRefSchema.safeParse(value);
  if (reference.success) {
    if (reference.data.nodeId !== WORKFLOW_INPUT_NODE_ID) {
      dependencies.add(reference.data.nodeId);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectDependencies(item, dependencies);
    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      collectDependencies(item, dependencies);
    }
  }
}
