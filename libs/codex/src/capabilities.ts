import type { AgentAdapterCapabilities } from "@seqlane/agent-adapter";

export const CODEX_AGENT_CAPABILITIES = {
  execute: true,
  modelSelection: true,
  structuredOutput: true,
  sessionReuse: true,
  checkpoint: true,
  fork: true,
  activity: true,
  sessionUi: false,
  userInput: true,
} as const satisfies AgentAdapterCapabilities;
