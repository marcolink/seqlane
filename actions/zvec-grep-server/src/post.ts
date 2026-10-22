import * as core from "@actions/core";
import { Effect } from "effect";
import {
  detachedProcessOwnershipSchema,
  terminateProcessGroup,
} from "@seqlane/action-service-lifecycle";
import { z } from "zod";

const positiveIntegerStateSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number);

const savedOwnershipStateSchema = z.object({
  pid: positiveIntegerStateSchema,
  processGroupId: positiveIntegerStateSchema,
  processStartTime: z.string().trim().min(1),
  sentinelPid: positiveIntegerStateSchema,
  sentinelProcessGroupId: positiveIntegerStateSchema,
  sentinelProcessStartTime: z.string().trim().min(1),
});

export async function run(): Promise<void> {
  const raw = {
    pid: core.getState("pid"),
    processGroupId: core.getState("process-group-id"),
    processStartTime: core.getState("process-start-time"),
    sentinelPid: core.getState("sentinel-pid"),
    sentinelProcessGroupId: core.getState("sentinel-process-group-id"),
    sentinelProcessStartTime: core.getState("sentinel-process-start-time"),
  };
  if (Object.values(raw).every((value) => value === "")) return;

  const fields = savedOwnershipStateSchema.safeParse(raw);
  if (!fields.success) {
    core.warning(
      "zvec-grep service state is malformed; skipping process cleanup",
    );
    return;
  }

  const ownership = detachedProcessOwnershipSchema.safeParse({
    pid: fields.data.pid,
    identity: {
      processGroupId: fields.data.processGroupId,
      processStartTime: fields.data.processStartTime,
    },
    sentinel: {
      pid: fields.data.sentinelPid,
      identity: {
        processGroupId: fields.data.sentinelProcessGroupId,
        processStartTime: fields.data.sentinelProcessStartTime,
      },
    },
  });
  if (!ownership.success || !ownership.data.sentinel) {
    core.warning(
      "zvec-grep service ownership is invalid; skipping process cleanup",
    );
    return;
  }

  const stopped = await Effect.runPromise(
    terminateProcessGroup(
      ownership.data.pid,
      ownership.data.identity,
      ownership.data.sentinel,
    ),
  );
  if (stopped) {
    core.info(`zvec-grep process group ${ownership.data.pid} stopped cleanly`);
  } else {
    core.warning(
      `zvec-grep process group ${ownership.data.pid} did not stop cleanly`,
    );
  }
}

if (process.env.NODE_ENV !== "test") {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
