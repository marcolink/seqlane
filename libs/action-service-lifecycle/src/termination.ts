import { Effect } from "effect";
import { z } from "zod";

import { ServiceLifecycleError } from "./errors.js";
import {
  isMissingProcess,
  processGroupIsActive,
  processIdentityMatches,
  waitForProcessGroupExit,
} from "./process-identity.js";
import {
  processMemberSchema,
  processIdentitySchema,
  type ProcessMember,
} from "./schemas.js";

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals) {
  return Effect.try({
    try: () => {
      process.kill(-processGroupId, signal);
      return true;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      isMissingProcess(cause)
        ? Effect.succeed(false)
        : Effect.fail(
            new ServiceLifecycleError(
              `Could not send ${signal} to process group ${processGroupId}`,
              cause,
            ),
          ),
    ),
  );
}

function normalizeMember(value: unknown): ProcessMember | undefined {
  const parsed = processMemberSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function matchingOwner(members: readonly (ProcessMember | undefined)[]) {
  return Effect.gen(function* () {
    for (const member of members) {
      if (
        !member ||
        !(yield* processGroupIsActive(member.identity.processGroupId))
      )
        continue;
      if (yield* processIdentityMatches(member.pid, member.identity))
        return member;
    }
    return undefined;
  });
}

function terminateVerifiedGroup(
  members: readonly (ProcessMember | undefined)[],
) {
  return Effect.gen(function* () {
    const owner = yield* matchingOwner(members);
    if (!owner) return false;
    const groupId = owner.identity.processGroupId;
    if (!(yield* signalProcessGroup(groupId, "SIGTERM"))) return true;
    if (yield* waitForProcessGroupExit(groupId, 5_000)) return true;

    const killOwner = yield* matchingOwner(members);
    if (!killOwner || killOwner.identity.processGroupId !== groupId)
      return yield* waitForProcessGroupExit(groupId, 2_000);
    if (!(yield* signalProcessGroup(groupId, "SIGKILL"))) return true;
    return yield* waitForProcessGroupExit(groupId, 2_000);
  });
}

export function terminateProcessGroup(
  pidValue: unknown,
  identityValue: unknown,
  sentinelValue?: unknown,
): Effect.Effect<boolean, ServiceLifecycleError> {
  const pid = z.number().int().positive().safeParse(pidValue);
  const identity = processIdentitySchema.safeParse(identityValue);
  const sentinel = normalizeMember(sentinelValue);
  const primary =
    pid.success && identity.success && pid.data === identity.data.processGroupId
      ? { pid: pid.data, identity: identity.data }
      : undefined;
  const usableSentinel =
    primary &&
    sentinel &&
    primary.identity.processGroupId !== sentinel.identity.processGroupId
      ? undefined
      : sentinel;
  const members = [primary, usableSentinel] as const;
  if (!primary && !usableSentinel) return Effect.succeed(false);
  return Effect.gen(function* () {
    const owner = primary ?? usableSentinel;
    if (!owner) return false;
    const active = yield* processGroupIsActive(owner.identity.processGroupId);
    if (!active) return true;
    return yield* terminateVerifiedGroup(members);
  });
}
