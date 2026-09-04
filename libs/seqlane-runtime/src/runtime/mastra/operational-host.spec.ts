// @test-scope ./operational-host.ts
// @test-scope ./mastra-composition.ts
// @test-scope ./mastra-server.ts
// @test-scope ../compile/mastra-plan-compiler.ts

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan, PlanNode } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createOperationalHost,
  createOperationalWorkflow,
} from "./operational-host.js";

function workflowPlan(): Plan {
  const node: PlanNode = {
    type: "task",
    taskId: "fixture.task",
    nodeId: "fixture.task:1",
    workspace: "exclusive",
    input: {},
    dependsOn: [],
  };
  return {
    workflow: { id: "fixture-workflow" },
    nodes: [node],
    output: { type: "ref", nodeId: node.nodeId, path: ["output"] },
  };
}

function registration() {
  return createOperationalWorkflow({
    key: "repository:fixture",
    plan: workflowPlan(),
    taskDefinitions: new Map([
      [
        "fixture.task",
        {
          id: "fixture.task",
          input: z.unknown(),
          output: z.unknown(),
          goal: () => "fixture",
        },
      ],
    ]),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("Mastra operational host", () => {
  it("registers workflows and becomes ready only after listening", async () => {
    const host = await createOperationalHost({
      workflows: [registration()],
      storageUrl: "file::memory:",
      port: 0,
    });

    await expect(
      json(await host.fetch(new Request("http://host/readyz"))),
    ).resolves.toMatchObject({
      status: "starting",
    });
    expect((await host.fetch(new Request("http://host/readyz"))).status).toBe(
      503,
    );

    const address = await host.listen();
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(host.ready).toBe(true);
    expect((await host.fetch(new Request("http://host/readyz"))).status).toBe(
      200,
    );
    expect((await host.fetch(new Request("http://host/healthz"))).status).toBe(
      200,
    );

    const workflows = await host.fetch(
      new Request("http://host/api/workflows"),
    );
    expect(workflows.status).toBe(200);
    expect(await json(workflows)).toHaveProperty("repository:fixture");

    await host.close();
    await host.close();
    expect(host.ready).toBe(false);
  });

  it("rejects non-loopback startup before opening storage or a listener", async () => {
    await expect(
      createOperationalHost({
        workflows: [registration()],
        host: "0.0.0.0",
        storageUrl: "file:/path/that/must/not/be opened",
      }),
    ).rejects.toThrow("loopback");
  });

  it("reopens the same durable storage file after host shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-operational-host-"));
    const storagePath = join(directory, "mastra.db");
    try {
      const first = await createOperationalHost({
        workflows: [registration()],
        storageUrl: `file:${storagePath}`,
        port: 0,
      });
      await first.listen();
      await first.close();
      expect(existsSync(storagePath)).toBe(true);

      const second = await createOperationalHost({
        workflows: [registration()],
        storageUrl: `file:${storagePath}`,
        port: 0,
      });
      await second.listen();
      expect(
        (await second.fetch(new Request("http://host/readyz"))).status,
      ).toBe(200);
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an empty workflow registry", async () => {
    await expect(
      createOperationalHost({ workflows: [], storageUrl: "file::memory:" }),
    ).rejects.toThrow("At least one workflow");
  });
});
