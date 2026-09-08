import { createHmac, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;
const TOKEN_CONTEXT = "seqlane-ripwire-action/session-token/v1";

/** Create the bearer token used by one Ripwire process. */
export function createSessionToken(seed?: string): string {
  const nonce = randomBytes(TOKEN_BYTES);
  if (seed === undefined) return nonce.toString("base64url");
  return createHmac("sha256", seed)
    .update(TOKEN_CONTEXT)
    .update(nonce)
    .digest("base64url");
}
