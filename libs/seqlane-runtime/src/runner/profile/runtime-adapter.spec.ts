// @test-scope ./runtime-adapter.ts
import type { AgentAdapter } from "@seqlane/agent-adapter";
import { describe, expect, it } from "vitest";
import {
  createRuntimeAdapterRegistry,
  loadRuntimeAdapterConfiguration,
  parseRuntimeAdapterConfiguration,
  redactRuntimeAdapterText,
  RuntimeAdapterConfigurationError,
  RuntimeAdapterSelectionError,
} from "./runtime-adapter.js";

const openCodeConfiguration = {
  adapter: "opencode" as const,
  url: "http://127.0.0.1:4096",
};

const acpConfiguration = {
  adapter: "acp" as const,
  configuration: {
    id: "test-acp",
    description: "Controlled ACP implementation",
    command: "test-acp",
    persistSession: true,
  },
};

function adapter(): AgentAdapter {
  return {
    capabilities: {
      execute: true,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: false,
      checkpoint: false,
      fork: false,
      activity: false,
      sessionUi: false,
    },
    execute: async () => ({ ok: true }),
  };
}

function factory(
  identity: "acp" | "opencode",
  selected: string[],
  options: { readonly fail?: boolean } = {},
) {
  return {
    identity,
    resolveCapabilities: () => adapter().capabilities,
    create: () => {
      selected.push(identity);
      if (options.fail) throw new Error("factory failed");
      return { createAdapter: () => adapter() };
    },
  };
}

describe("private runtime adapter selection", () => {
  it.each([
    [undefined, "missing"],
    [{}, "missing identity"],
    [
      { adapter: "unknown", url: openCodeConfiguration.url },
      "unknown identity",
    ],
    [{ url: openCodeConfiguration.url }, "ambiguous identity"],
    [
      { adapter: "opencode", url: openCodeConfiguration.url, command: "acp" },
      "mixed configuration",
    ],
    [
      {
        adapter: "acp",
        configuration: { ...acpConfiguration.configuration },
        url: openCodeConfiguration.url,
      },
      "mixed configuration",
    ],
    [
      { adapter: "opencode", url: "https://user:secret@example.test" },
      "credentialed URL",
    ],
  ])("rejects %s", (value) => {
    expect(() => parseRuntimeAdapterConfiguration(value)).toThrow(
      RuntimeAdapterConfigurationError,
    );
    expect(() => parseRuntimeAdapterConfiguration(value)).not.toThrow("secret");
  });

  it("loads and validates one explicit configuration from the private environment", () => {
    expect(
      loadRuntimeAdapterConfiguration({
        SEQLANE_RUNTIME_ADAPTER_CONFIG: JSON.stringify(openCodeConfiguration),
      }),
    ).toEqual(openCodeConfiguration);
    expect(() =>
      loadRuntimeAdapterConfiguration({
        SEQLANE_RUNTIME_ADAPTER_CONFIG: JSON.stringify({
          url: openCodeConfiguration.url,
        }),
      }),
    ).toThrow(RuntimeAdapterConfigurationError);
  });

  it("selects the registered factory deterministically", () => {
    const selected: string[] = [];
    const registry = createRuntimeAdapterRegistry([
      factory("acp", selected),
      factory("opencode", selected),
    ]);

    registry
      .resolve(acpConfiguration)
      .create({ signal: new AbortController().signal });
    registry
      .resolve(openCodeConfiguration)
      .create({ signal: new AbortController().signal });

    expect(selected).toEqual(["acp", "opencode"]);
  });

  it("validates before invoking a factory and never falls back after a factory failure", () => {
    const selected: string[] = [];
    const registry = createRuntimeAdapterRegistry([
      factory("acp", selected),
      factory("opencode", selected, { fail: true }),
    ]);

    expect(() =>
      registry.resolve({ adapter: "opencode", url: "not a URL" }),
    ).toThrow(RuntimeAdapterConfigurationError);
    expect(selected).toEqual([]);

    expect(() =>
      registry.resolve(openCodeConfiguration).create({
        signal: new AbortController().signal,
      }),
    ).toThrow(RuntimeAdapterSelectionError);
    expect(selected).toEqual(["opencode"]);
  });

  it("redacts credential values from private diagnostics", () => {
    const configuration = parseRuntimeAdapterConfiguration({
      ...acpConfiguration,
      configuration: {
        ...acpConfiguration.configuration,
        env: { ACP_TOKEN: "secret-token" },
      },
    });

    expect(
      redactRuntimeAdapterText(
        "ACP failed with secret-token while starting",
        configuration,
      ),
    ).toBe("ACP failed with [REDACTED] while starting");
  });
});
