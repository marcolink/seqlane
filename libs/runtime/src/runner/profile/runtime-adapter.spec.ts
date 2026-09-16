// @test-scope ./runtime-adapter.ts
import type { AgentAdapter } from "@seqlane/agent-adapter";
import { describe, expect, it } from "vitest";
import {
  assertRuntimeAdapterCapabilities,
  createRuntimeAdapterRegistry,
  loadRuntimeAdapterConfiguration,
  parseRuntimeAdapterConfiguration,
  configurationWithWorkspace,
  redactRuntimeAdapter,
  redactRuntimeAdapterText,
  RuntimeAdapterConfigurationError,
  RuntimeAdapterSelectionError,
  RuntimeAdapterUnavailableError,
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

const codexConfiguration = {
  adapter: "codex" as const,
  executable: "/opt/codex",
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
    prepare: async () => ({}),
    create: () => {
      selected.push(identity);
      if (options.fail) throw new Error("factory failed");
      return { createAdapter: () => adapter() };
    },
  };
}

describe("private runtime adapter selection", () => {
  it("accepts explicit Codex configuration and applies the runtime workspace", () => {
    expect(parseRuntimeAdapterConfiguration(codexConfiguration)).toEqual({
      ...codexConfiguration,
      networkAccess: false,
    });
    expect(
      configurationWithWorkspace(codexConfiguration, "/workspace"),
    ).toEqual({
      ...codexConfiguration,
      networkAccess: false,
      workspace: "/workspace",
    });
    expect(
      createRuntimeAdapterRegistry().resolve(
        configurationWithWorkspace(codexConfiguration, "/workspace"),
      ).configuration,
    ).toEqual({
      ...codexConfiguration,
      networkAccess: false,
      workspace: "/workspace",
    });
    expect(() =>
      parseRuntimeAdapterConfiguration({
        ...codexConfiguration,
        executable: "codex",
      }),
    ).toThrow(RuntimeAdapterConfigurationError);
  });

  it("selects Codex with its native capabilities", () => {
    const selected = createRuntimeAdapterRegistry().resolve(codexConfiguration);
    expect(selected.identity).toBe("codex");
    expect(selected.capabilities).toEqual({
      execute: true,
      modelSelection: true,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: true,
      fork: true,
      activity: true,
      sessionUi: false,
    });
  });

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
  ])("rejects %s (%s)", (value, description) => {
    expect(description).toBeTypeOf("string");
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

  it("does not advertise ACP request-level model selection", () => {
    const configuration = parseRuntimeAdapterConfiguration({
      ...acpConfiguration,
      configuration: {
        ...acpConfiguration.configuration,
        model: "provider/model",
      },
    });

    expect(
      createRuntimeAdapterRegistry().resolve(configuration).capabilities,
    ).toMatchObject({ modelSelection: false });
  });

  it("derives OpenCode session UI from prepared endpoint capabilities", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      const selected = createRuntimeAdapterRegistry().resolve(
        openCodeConfiguration,
      );
      const preparation = await selected.prepare(new AbortController().signal);

      expect(preparation.browserUiUrl).toBeUndefined();
      expect(selected.resolveCapabilities(preparation).sessionUi).toBe(false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("reports unavailable adapters without leaking transport details", async () => {
    const transportFailure = new Error("fetch failed at secret endpoint");
    const selected = createRuntimeAdapterRegistry([
      {
        identity: "opencode",
        resolveCapabilities: () => adapter().capabilities,
        prepare: async () => ({}),
        create: () => ({
          createAdapter: () => adapter(),
          modelCapabilities: {
            executor: "opencode",
            listModels: async () => {
              throw transportFailure;
            },
            resolveDefaultModel: async () => ({
              model: { provider: "openai", model: "test-model" },
            }),
          },
        }),
      },
    ]).resolve({
      adapter: "opencode",
      url: "https://runtime.test/secret",
    });
    const capabilities = selected.create({
      signal: new AbortController().signal,
    }).modelCapabilities;

    await expect(capabilities?.listModels()).rejects.toMatchObject({
      name: "RuntimeAdapterUnavailableError",
      message: 'adapter "opencode" unavailable',
      adapter: "opencode",
      cause: { message: "fetch failed at [REDACTED] endpoint" },
    });
    await expect(capabilities?.listModels()).rejects.toBeInstanceOf(
      RuntimeAdapterUnavailableError,
    );
  });

  it("rejects capability declarations without matching optional operations", () => {
    const capabilities = {
      ...adapter().capabilities,
      checkpoint: true,
    };

    expect(() =>
      assertRuntimeAdapterCapabilities(
        { ...adapter(), capabilities },
        capabilities,
      ),
    ).toThrow(/optional operation/i);
  });

  it("redacts ACP arguments and OpenCode URL path, query, and fragment values", () => {
    const acp = parseRuntimeAdapterConfiguration({
      ...acpConfiguration,
      configuration: {
        ...acpConfiguration.configuration,
        args: ["--token", "arg-secret"],
        env: { ACP_TOKEN: "env-secret" },
      },
    });
    expect(redactRuntimeAdapterText("--token arg-secret env-secret", acp)).toBe(
      "[REDACTED] [REDACTED] [REDACTED]",
    );

    const openCode = parseRuntimeAdapterConfiguration({
      adapter: "opencode",
      url: "https://runtime.test/path/token-secret?access=access-secret#auth-secret",
    });
    expect(
      redactRuntimeAdapterText(
        "https://runtime.test/path/token-secret access-secret auth-secret",
        openCode,
      ),
    ).toBe("https://runtime.test/[REDACTED]/[REDACTED] [REDACTED] [REDACTED]");
  });

  it("redacts diagnostics and preserves typed errors and causes at the adapter boundary", async () => {
    const cause = new Error("request failed with env-secret");
    const failure = Object.assign(new Error("adapter failed with env-secret"), {
      code: "adapter-failure",
      cause,
    });
    const diagnostics: string[] = [];
    const wrapped = redactRuntimeAdapter(
      {
        capabilities: adapter().capabilities,
        execute: async (request) => {
          request.onDiagnostic?.({ code: "diagnostic", message: "arg-secret" });
          throw failure;
        },
      },
      parseRuntimeAdapterConfiguration({
        ...acpConfiguration,
        configuration: {
          ...acpConfiguration.configuration,
          args: ["arg-secret"],
          env: { TOKEN: "env-secret" },
        },
      }),
    );

    await expect(
      wrapped.execute({
        invocationId: "invocation-1",
        observability: {},
        task: {} as never,
        input: null,
        signal: new AbortController().signal,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      }),
    ).rejects.toMatchObject({
      code: "adapter-failure",
      message: "adapter failed with [REDACTED]",
      cause: { message: "request failed with [REDACTED]" },
    });
    expect(diagnostics).toEqual(["[REDACTED]"]);
  });

  it("validates before applying the typed workspace override", () => {
    expect(() =>
      configurationWithWorkspace(
        { adapter: "opencode", url: "not-a-url" },
        "/workspace",
      ),
    ).toThrow(RuntimeAdapterConfigurationError);
    expect(() => configurationWithWorkspace(null, "/workspace")).toThrow(
      RuntimeAdapterConfigurationError,
    );
    expect(
      configurationWithWorkspace(openCodeConfiguration, "/workspace"),
    ).toEqual({ ...openCodeConfiguration, workspace: "/workspace" });
  });
});
