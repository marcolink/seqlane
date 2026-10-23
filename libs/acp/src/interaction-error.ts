import { InteractionRequiredError } from "@seqlane/core";

export function interactionError(cause: unknown): InteractionRequiredError {
  const error = new InteractionRequiredError("user-input");
  Object.defineProperty(error, "cause", { value: cause, configurable: true });
  return error;
}
