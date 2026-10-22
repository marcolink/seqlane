export type { OwnedProcessIdentity } from "@seqlane/protocol/private/owned-process";
export {
  OwnedProcessIdentityError,
  captureOwnedProcessIdentity,
  confirmOwnedProcessGroupStopped,
  confirmOwnedProcessStopped,
  isOwnedProcessIdentityCurrent,
  terminateOwnedProcess,
} from "./identity.js";
