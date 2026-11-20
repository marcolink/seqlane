import { Flags } from "@oclif/core";
import { z } from "zod";
import { createDirectRunAdapterConfiguration } from "./agent-runtime.js";
const openCodeV2AdapterOnlyRelationships = [
  {
    type: "none" as const,
    flags: [
      {
        name: "adapter",
        when: async (flags: Record<string, unknown>) =>
          flags.adapter !== "opencode-v2",
      },
    ],
  },
];

export const openCodeV2Flags = {
  "opencode-v2-mode": Flags.string({
    description: "OpenCode V2 service ownership",
    options: ["managed", "external"],
    dependsOn: ["adapter"],
    relationships: openCodeV2AdapterOnlyRelationships,
  }),
  "opencode-v2-host": Flags.string({
    description: "OpenCode V2 loopback host",
    dependsOn: ["adapter"],
    relationships: openCodeV2AdapterOnlyRelationships,
  }),
  "opencode-v2-port": Flags.integer({
    description: "OpenCode V2 port (managed default: 0)",
    dependsOn: ["adapter"],
    relationships: openCodeV2AdapterOnlyRelationships,
  }),
  "opencode-v2-executable": Flags.string({
    description: "Absolute OpenCode V2 executable path (managed only)",
    dependsOn: ["adapter"],
    relationships: openCodeV2AdapterOnlyRelationships,
  }),
};

const adapterFlagsSchema = z.object({
  adapter: z.string().optional(),
  "opencode-mode": z.string().optional(),
  "opencode-host": z.string().optional(),
  "opencode-port": z.number().optional(),
  "opencode-executable": z.string().optional(),
  "opencode-v2-mode": z.string().optional(),
  "opencode-v2-host": z.string().optional(),
  "opencode-v2-port": z.number().optional(),
  "opencode-v2-executable": z.string().optional(),
});

export function createRunAdapterConfiguration(
  value: unknown,
): string | undefined {
  const flags = adapterFlagsSchema.parse(value);
  if (flags.adapter === undefined) return undefined;
  if (flags.adapter === "codex")
    return createDirectRunAdapterConfiguration({ adapter: "codex" });
  const prefix = flags.adapter === "opencode-v2" ? "opencode-v2" : "opencode";
  const executable = flags[`${prefix}-executable`];
  return createDirectRunAdapterConfiguration({
    adapter: flags.adapter,
    mode: flags[`${prefix}-mode`] ?? "managed",
    host: flags[`${prefix}-host`],
    port: flags[`${prefix}-port`],
    ...(executable === undefined ? {} : { executable }),
  });
}
