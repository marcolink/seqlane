import { Effect } from "effect";
import { runTest } from "./native-test-support.js";
// @test-scope ./sqlite-store.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  OperationalStorageError,
  OperationalStorageVersionError,
  OperationalStoreBusyError,
  openOperationalStore,
  type OperationalStore,
} from "./sqlite-store.js";

const createdStores: OperationalStore[] = [];
const temporaryDirectories: string[] = [];
const timestamp = "2026-10-22T12:00:00.000Z";

function makeDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "seqlane-operations-"));
  temporaryDirectories.push(directory);
  return join(directory, "operations.db");
}

async function openStore(
  path = makeDatabasePath(),
): Promise<{ path: string; store: OperationalStore }> {
  const store = await runTest(openOperationalStore(`file:${path}`));
  createdStores.push(store);
  return { path, store };
}

async function createRun(
  store: OperationalStore,
  runId: string,
): Promise<void> {
  await runTest(
    store.createRun({
      workId: `work-${runId}`,
      runId,
      workflowKey: "review",
      createdAt: timestamp,
    }),
  );
}

function event(
  sequence: number,
  runId: string,
  type: "run.started" | "run.succeeded" = "run.started",
) {
  const common = {
    metadata: {
      schemaVersion: 1 as const,
      eventId: `event-${sequence}`,
      sequence,
      occurredAt: timestamp,
    },
    workId: `work-${runId}`,
    runId,
  };
  return type === "run.succeeded"
    ? { ...common, type, output: false }
    : { ...common, type };
}

afterEach(async () => {
  await Promise.all(
    createdStores.splice(0).map((store) => runTest(store.close())),
  );
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("hosted SQLite operations store", () => {
  it("releases database ownership when the owning Effect scope closes", async () => {
    const path = makeDatabasePath();
    const store = await runTest(
      Effect.scoped(openOperationalStore(`file:${path}`)),
    );
    expect(store.healthy).toBe(false);
    const reopened = await openStore(path);
    expect(reopened.store.healthy).toBe(true);
  });

  it("persists false-like results and full event data after reopen", async () => {
    const { path, store } = await openStore();
    await createRun(store, "run-false");
    await runTest(store.appendEvent("run-false", event(1, "run-false")));
    await runTest(
      store.appendEvent("run-false", event(2, "run-false", "run.succeeded")),
    );
    await runTest(
      store.completeRun({
        runId: "run-false",
        status: "succeeded",
        updatedAt: timestamp,
        output: false,
        spans: [],
        droppedRecords: 0,
      }),
    );
    await runTest(store.close());

    const reopened = await openStore(path);
    await expect(
      runTest(reopened.store.status("run-false")),
    ).resolves.toMatchObject({
      status: "succeeded",
      output: false,
      completeness: { inspection: "complete" },
    });
    await expect(
      runTest(
        reopened.store.events("run-false", { afterSequence: 0, limit: 20 }),
      ),
    ).resolves.toMatchObject({
      events: [{ sequence: 1 }, { sequence: 2 }],
      terminalEvent: { type: "run.succeeded", output: false },
    });
    await expect(
      runTest(reopened.store.trace("run-false")),
    ).resolves.toMatchObject({
      spans: [],
      completeness: { inspection: "complete" },
    });
  });

  it("returns a 15.5 MiB canonical event whole within the bounded page", async () => {
    const { store } = await openStore();
    await createRun(store, "large-event");
    const payload = "x".repeat(15.5 * 1024 * 1024);
    await runTest(
      store.appendEvent("large-event", {
        ...event(1, "large-event", "run.succeeded"),
        output: { payload },
      }),
    );
    await runTest(
      store.completeRun({
        runId: "large-event",
        status: "succeeded",
        updatedAt: timestamp,
        output: false,
        spans: [],
        droppedRecords: 0,
      }),
    );

    const page = await runTest(
      store.events("large-event", {
        afterSequence: 0,
        limit: 10,
      }),
    );
    const output = page?.events[0]?.event;
    expect(output?.type).toBe("run.succeeded");
    expect(
      output?.type === "run.succeeded" ? output.output : undefined,
    ).toEqual({ payload });
    expect(page?.terminalEvent).toBeUndefined();
  });

  it("recovers queued and running rows as interrupted without replay", async () => {
    const { path, store } = await openStore();
    await createRun(store, "queued");
    await createRun(store, "running");
    await runTest(store.setRunning("running", timestamp));
    await runTest(store.close());

    const reopened = await openStore(path);
    await expect(
      runTest(reopened.store.status("queued")),
    ).resolves.toMatchObject({
      status: "interrupted",
      completeness: { inspection: "incomplete" },
    });
    await expect(
      runTest(reopened.store.status("running")),
    ).resolves.toMatchObject({
      status: "interrupted",
      completeness: { inspection: "incomplete" },
    });
  });

  it("persists a completed task outcome when inspection persistence is incomplete", async () => {
    const { path, store } = await openStore();
    await createRun(store, "incomplete");
    await runTest(store.setRunning("incomplete", timestamp));
    const validationError = {
      category: "ValidationError" as const,
      message: "Output did not match the declared schema",
      taskId: "task-1",
      validation: {
        validationNodeId: "validate-1",
        sourceId: "output-1",
        issues: [{ code: "invalid_type", message: "Expected string" }],
        evidence: { state: "present" as const, value: false },
      },
    };
    await runTest(
      store.markIncomplete({
        runId: "incomplete",
        status: "failed",
        updatedAt: timestamp,
        error: validationError,
        storageError: new Error("Trace export retention reached its bound"),
      }),
    );
    await expect(runTest(store.status("incomplete"))).resolves.toMatchObject({
      status: "failed",
      error: validationError,
      completeness: {
        inspection: "incomplete",
        storageError: {
          category: "RuntimeError",
          message: "Trace export retention reached its bound",
        },
      },
    });
    await runTest(store.close());
    await expect(runTest(store.close())).resolves.toBeUndefined();

    const reopened = await openStore(path);
    await expect(
      runTest(reopened.store.status("incomplete")),
    ).resolves.toMatchObject({
      status: "failed",
      error: validationError,
      completeness: { inspection: "incomplete" },
    });
  });

  it("rejects another writer promptly while the first host owns the database", async () => {
    const path = makeDatabasePath();
    const first = await openStore(path);
    await createRun(first.store, "active");
    const started = Date.now();
    await expect(
      runTest(openOperationalStore(`file:${path}`)),
    ).rejects.toBeInstanceOf(OperationalStoreBusyError);
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(runTest(first.store.status("active"))).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("reports duplicate run identities as conflicts without degrading storage health", async () => {
    const { store } = await openStore();
    await createRun(store, "duplicate");
    await expect(createRun(store, "duplicate")).rejects.toMatchObject({
      name: "OperationalRunConflictError",
      runId: "duplicate",
    });
    expect(store.healthy).toBe(true);
    await expect(runTest(store.status("duplicate"))).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("rejects unrelated databases before changing their schema", async () => {
    const path = makeDatabasePath();
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE customer_data (value TEXT)");
    database.close();

    await expect(
      runTest(openOperationalStore(`file:${path}`)),
    ).rejects.toBeInstanceOf(OperationalStorageVersionError);
    const reopened = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        reopened
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all(),
      ).toEqual([{ name: "customer_data" }]);
      expect(reopened.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "delete",
      });
    } finally {
      reopened.close();
    }
  });

  it("reports corrupt persisted byte metadata and still closes an unhealthy store", async () => {
    const { path, store } = await openStore();
    await createRun(store, "corrupt-event");
    await runTest(
      store.appendEvent("corrupt-event", event(1, "corrupt-event")),
    );
    await runTest(store.close());
    const database = new DatabaseSync(path);
    database.exec(
      "UPDATE operational_events SET byte_count = 0 WHERE run_id = 'corrupt-event'",
    );
    database.close();

    const reopened = await openStore(path);
    await expect(
      runTest(
        reopened.store.events("corrupt-event", { afterSequence: 0, limit: 10 }),
      ),
    ).rejects.toBeInstanceOf(OperationalStorageError);
    expect(reopened.store.healthy).toBe(false);
    await expect(runTest(reopened.store.close())).resolves.toBeUndefined();
    expect(reopened.store.healthy).toBe(false);
  });

  it("paginates run listing without repeating or skipping rows", async () => {
    const { store } = await openStore();
    for (let index = 0; index < 5; index += 1)
      await createRun(store, `page-${index}`);
    const first = await runTest(store.list({ limit: 2 }));
    const second = await runTest(
      store.list({ limit: 2, cursor: first.nextCursor }),
    );
    const third = await runTest(
      store.list({ limit: 2, cursor: second.nextCursor }),
    );
    const ids = [...first.runs, ...second.runs, ...third.runs].map(
      (run) => run.runId,
    );
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("reports one inclusive missing range per event page and preserves future cursors", async () => {
    const { path, store } = await openStore();
    await createRun(store, "gaps");
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await runTest(
        store.appendEvent(
          "gaps",
          event(
            sequence,
            "gaps",
            sequence === 5 ? "run.succeeded" : "run.started",
          ),
        ),
      );
    }
    await runTest(
      store.completeRun({
        runId: "gaps",
        status: "succeeded",
        updatedAt: timestamp,
        output: false,
        spans: [],
        droppedRecords: 0,
      }),
    );
    await runTest(store.close());
    const database = new DatabaseSync(path);
    database.exec(
      "DELETE FROM operational_events WHERE run_id = 'gaps' AND sequence IN (2, 4)",
    );
    database.close();

    const reopened = await openStore(path);
    await expect(
      runTest(reopened.store.events("gaps", { afterSequence: 0, limit: 10 })),
    ).resolves.toMatchObject({
      events: [{ sequence: 1 }, { sequence: 3 }],
      gap: { fromSequence: 2, toSequence: 2 },
      nextSequence: 3,
    });
    await expect(
      runTest(reopened.store.events("gaps", { afterSequence: 3, limit: 10 })),
    ).resolves.toMatchObject({
      events: [{ sequence: 5 }],
      gap: { fromSequence: 4, toSequence: 4 },
      nextSequence: 5,
      terminalEvent: { type: "run.succeeded" },
    });
    await expect(
      runTest(reopened.store.events("gaps", { afterSequence: 20, limit: 10 })),
    ).resolves.toMatchObject({ events: [], nextSequence: 20 });
  });

  it("reports trailing missing rows without replacing an earlier page gap", async () => {
    const { path, store } = await openStore();
    await createRun(store, "trailing-gap");
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      await runTest(
        store.appendEvent(
          "trailing-gap",
          event(
            sequence,
            "trailing-gap",
            sequence === 3 ? "run.succeeded" : "run.started",
          ),
        ),
      );
    }
    await runTest(
      store.completeRun({
        runId: "trailing-gap",
        status: "succeeded",
        updatedAt: timestamp,
        output: false,
        spans: [],
        droppedRecords: 0,
      }),
    );

    await createRun(store, "two-gaps");
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await runTest(
        store.appendEvent(
          "two-gaps",
          event(
            sequence,
            "two-gaps",
            sequence === 5 ? "run.succeeded" : "run.started",
          ),
        ),
      );
    }
    await runTest(
      store.completeRun({
        runId: "two-gaps",
        status: "succeeded",
        updatedAt: timestamp,
        output: false,
        spans: [],
        droppedRecords: 0,
      }),
    );
    await runTest(store.close());

    const database = new DatabaseSync(path);
    database.exec(
      "DELETE FROM operational_events WHERE run_id = 'trailing-gap' AND sequence = 3; DELETE FROM operational_events WHERE run_id = 'two-gaps' AND sequence IN (2, 4, 5)",
    );
    database.close();

    const reopened = await openStore(path);
    await expect(
      runTest(
        reopened.store.events("trailing-gap", { afterSequence: 0, limit: 10 }),
      ),
    ).resolves.toMatchObject({
      events: [{ sequence: 1 }, { sequence: 2 }],
      gap: { fromSequence: 3, toSequence: 3 },
      nextSequence: 2,
      completeness: { inspection: "incomplete" },
    });
    await expect(
      runTest(
        reopened.store.events("two-gaps", { afterSequence: 0, limit: 10 }),
      ),
    ).resolves.toMatchObject({
      events: [{ sequence: 1 }, { sequence: 3 }],
      gap: { fromSequence: 2, toSequence: 2 },
      nextSequence: 3,
    });
    await expect(
      runTest(
        reopened.store.events("two-gaps", { afterSequence: 3, limit: 10 }),
      ),
    ).resolves.toMatchObject({
      events: [],
      gap: { fromSequence: 4, toSequence: 5 },
      nextSequence: 3,
      completeness: { inspection: "incomplete" },
    });
    const futurePage = await runTest(
      reopened.store.events("two-gaps", {
        afterSequence: 20,
        limit: 10,
      }),
    );
    expect(futurePage).toMatchObject({ events: [], nextSequence: 20 });
    expect(futurePage).not.toHaveProperty("gap");
  });
});
