import type { ModelSelection } from "@seqlane/core";
import type { z } from "zod";
import type { sessionSchema } from "./schemas.js";
import { nativeModel } from "./models.js";
import { OpenCodeV2Error } from "./errors.js";

export type PinnedNativeModel = NonNullable<
  z.infer<typeof sessionSchema>["model"]
>;

export function assertAssistantModel(
  actual: PinnedNativeModel,
  expected: PinnedNativeModel,
): void {
  if (
    actual.providerID !== expected.providerID ||
    actual.id !== expected.id ||
    actual.variant !== expected.variant
  )
    throw new OpenCodeV2Error(
      "protocol",
      "native assistant changed the selected model",
    );
}

/** Reject native substitution, including a model changed outside this run. */
export function assertSessionModel(
  session: z.infer<typeof sessionSchema>,
  selection: ModelSelection,
) {
  const expected = nativeModel(selection);
  if (
    session.model?.providerID !== expected.providerID ||
    session.model.id !== expected.id ||
    (expected.variant !== undefined &&
      session.model.variant !== expected.variant)
  )
    throw new OpenCodeV2Error(
      "protocol",
      "native session changed the selected model",
    );
  return session.model;
}
