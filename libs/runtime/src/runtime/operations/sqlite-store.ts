import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { LockTimeoutError, UniqueViolation } from "effect/sql/SqlError";
import { jsonValueSchema, type JsonValue } from "@seqlane/core";
import {
  operationalRunCompletenessSchema,
  operationalRunEventsSchema,
  operationalRunListSchema,
  operationalRunStatusSchema,
  operationalRunSummarySchema,
  operationalTraceInspectionSchema,
  seqlaneExecutionEventSchema,
  serializedSeqlaneErrorSchema,
  serializeSeqlaneError,
  type OperationalRunEvents,
  type OperationalRunList,
  type OperationalRunStatus,
  type OperationalTraceInspection,
} from "@seqlane/protocol";
import {
  telemetrySpanSnapshotSchema,
  type TelemetrySpanSnapshot,
} from "@seqlane/protocol/private/telemetry-span-snapshot";
import { z } from "zod";

const APPLICATION_ID = 1_397_046_092;
const SCHEMA_VERSION = 1;
const DEFAULT_STORAGE_URL = "file:./.seqlane/operations.db";
const BUSY_TIMEOUT_MS = 25;
const EVENT_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_PAGE_COUNT = 1000;

const sqlitePragmaRow = z.strictObject({
  application_id: z.number().int(),
  user_version: z.number().int(),
});
const sqliteTableNameRow = z.strictObject({ name: z.string() });
const sqliteColumnRow = z.object({ name: z.string() });
const storedRunRow = z.strictObject({
  work_id: z.string(),
  run_id: z.string(),
  workflow_key: z.string(),
  status: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  created_at: z.string(),
  updated_at: z.string(),
  output_json: z.string().nullable(),
  error_json: z.string().nullable(),
  inspection_complete: z.number().int(),
  storage_error_json: z.string().nullable(),
});
const storedEventSizeRow = z.strictObject({
  sequence: z.number().int().nonnegative(),
  byte_count: z.number().int().nonnegative(),
  actual_byte_count: z.number().int().nonnegative(),
});
const storedTraceRow = z.strictObject({
  trace_id: z.string().nullable(),
  spans_json: z.string(),
  dropped_records: z.number().int().nonnegative(),
});
const storedSummaryRow = z.strictObject({
  rowid: z.number().int().nonnegative(),
  work_id: z.string(),
  run_id: z.string(),
  workflow_key: z.string(),
  status: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  created_at: z.string(),
  updated_at: z.string(),
});
const storedSequenceRow = z.strictObject({
  next_sequence: z.number().int().nonnegative(),
});
const storedModeRow = z.strictObject({ locking_mode: z.literal("exclusive") });
const storedJournalModeRow = z.strictObject({ journal_mode: z.string() });

const EXPECTED_TABLES = [
  "operational_events",
  "operational_runs",
  "operational_traces",
];
const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  operational_events: ["run_id", "sequence", "event_json", "byte_count"],
  operational_runs: [
    "work_id",
    "run_id",
    "workflow_key",
    "status",
    "created_at",
    "updated_at",
    "output_json",
    "error_json",
    "inspection_complete",
    "storage_error_json",
    "next_sequence",
  ],
  operational_traces: ["run_id", "trace_id", "spans_json", "dropped_records"],
};

export class OperationalStorageVersionError extends Error {
  constructor(readonly path: string) {
    super(
      `Operational history database is not a supported Seqlane database: ${path}`,
    );
    this.name = "OperationalStorageVersionError";
  }
}

export class OperationalStorageError extends Error {
  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super(`Operational history storage failed during ${operation}`, { cause });
    this.name = "OperationalStorageError";
  }
}

export class OperationalStoreBusyError extends OperationalStorageError {
  constructor(
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super("acquire exclusive database lock", options?.cause);
    this.name = "OperationalStoreBusyError";
  }
}

export class OperationalRunConflictError extends Error {
  constructor(
    readonly runId: string,
    cause: unknown,
  ) {
    super(`Hosted run already exists: ${runId}`, { cause });
    this.name = "OperationalRunConflictError";
  }
}

const sqliteBusyCauseSchema = z.custom<unknown>((cause) => {
  const pending: unknown[] = [cause];
  for (let depth = 0; depth < 4; depth += 1) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (current instanceof LockTimeoutError) return true;
    const byCode = z
      .object({ code: z.enum(["SQLITE_BUSY", "SQLITE_LOCKED"]) })
      .passthrough()
      .safeParse(current);
    if (byCode.success) return true;
    const byNumber = z
      .object({ errcode: z.number().int().nonnegative() })
      .passthrough()
      .safeParse(current);
    if (byNumber.success && [5, 6].includes(byNumber.data.errcode & 0xff))
      return true;
    const nested = z
      .object({ cause: z.unknown(), reason: z.unknown().optional() })
      .passthrough()
      .safeParse(current);
    if (nested.success) pending.push(nested.data.cause, nested.data.reason);
  }
  return false;
});

const sqliteUniqueCauseSchema = z.custom<unknown>((cause) => {
  const pending: unknown[] = [cause];
  for (let depth = 0; depth < 4; depth += 1) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (current instanceof UniqueViolation) return true;
    if (
      z
        .object({
          code: z.enum([
            "SQLITE_CONSTRAINT_UNIQUE",
            "SQLITE_CONSTRAINT_PRIMARYKEY",
          ]),
        })
        .passthrough()
        .safeParse(current).success
    )
      return true;
    const sqliteNumber = z
      .object({ errcode: z.number().int().nonnegative() })
      .passthrough()
      .safeParse(current);
    if (
      sqliteNumber.success &&
      [1555, 2067].includes(sqliteNumber.data.errcode)
    )
      return true;
    const nested = z
      .object({ cause: z.unknown(), reason: z.unknown().optional() })
      .passthrough()
      .safeParse(current);
    if (nested.success) pending.push(nested.data.cause, nested.data.reason);
  }
  return false;
});

export interface OperationalStore {
  readonly healthy: boolean;
  createRun(input: {
    readonly workId: string;
    readonly runId: string;
    readonly workflowKey: string;
    readonly createdAt: string;
  }): Effect.Effect<void, unknown>;
  setRunning(runId: string, updatedAt: string): Effect.Effect<void, unknown>;
  appendEvent(runId: string, event: unknown): Effect.Effect<void, unknown>;
  completeRun(input: {
    readonly runId: string;
    readonly status: Extract<
      OperationalRunStatus["status"],
      "succeeded" | "failed" | "cancelled"
    >;
    readonly updatedAt: string;
    readonly output?: JsonValue;
    readonly error?: unknown;
    readonly spans: readonly TelemetrySpanSnapshot[];
    readonly droppedRecords: number;
  }): Effect.Effect<void, unknown>;
  markIncomplete(input: {
    readonly runId: string;
    readonly status: Extract<
      OperationalRunStatus["status"],
      "succeeded" | "failed" | "cancelled"
    >;
    readonly updatedAt: string;
    readonly output?: JsonValue;
    readonly error?: unknown;
    readonly storageError: unknown;
    readonly spans?: readonly TelemetrySpanSnapshot[];
    readonly droppedRecords?: number;
  }): Effect.Effect<void, unknown>;
  status(
    runId: string,
  ): Effect.Effect<OperationalRunStatus | undefined, unknown>;
  list(options: {
    readonly limit: number;
    readonly cursor?: number;
  }): Effect.Effect<OperationalRunList, unknown>;
  events(
    runId: string,
    options: { readonly afterSequence: number; readonly limit: number },
  ): Effect.Effect<OperationalRunEvents | undefined, unknown>;
  trace(
    runId: string,
  ): Effect.Effect<OperationalTraceInspection | undefined, unknown>;
  close(): Effect.Effect<void, unknown>;
}

function storagePath(storageUrl: string | undefined): string {
  const url = storageUrl ?? DEFAULT_STORAGE_URL;
  if (!url.startsWith("file:"))
    throw new TypeError("Hosted operations storage must use a SQLite file URL");
  const path = url.slice("file:".length);
  if (path === "::memory:" || path === ":memory:") return ":memory:";
  if (path.length === 0) throw new TypeError("SQLite storage path is required");
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function preflightDatabase(path: string): void {
  if (path === ":memory:" || !existsSync(path)) return;
  // This read-only probe happens before the Effect SQL client can enable WAL.
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, {
      readOnly: true,
      timeout: BUSY_TIMEOUT_MS,
    });
  } catch (cause) {
    if (sqliteBusyCauseSchema.safeParse(cause).success)
      throw new OperationalStoreBusyError(path, { cause });
    throw cause;
  }
  try {
    const applicationId = database.prepare("PRAGMA application_id").get();
    const userVersion = database.prepare("PRAGMA user_version").get();
    const pragma = sqlitePragmaRow.parse(
      applicationId === undefined || userVersion === undefined
        ? {}
        : {
            application_id: applicationId.application_id,
            user_version: userVersion.user_version,
          },
    );
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => sqliteTableNameRow.parse(row).name);
    const fresh =
      pragma.application_id === 0 &&
      pragma.user_version === 0 &&
      tables.length === 0;
    const supported =
      pragma.application_id === APPLICATION_ID &&
      pragma.user_version === SCHEMA_VERSION &&
      tables.length === EXPECTED_TABLES.length &&
      EXPECTED_TABLES.every((name, index) => tables[index] === name);
    if (!fresh && !supported) throw new OperationalStorageVersionError(path);
    if (supported) {
      for (const table of EXPECTED_TABLES) {
        const columns = database
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => sqliteColumnRow.parse(row).name);
        const expected = EXPECTED_COLUMNS[table];
        if (
          expected === undefined ||
          columns.length !== expected.length ||
          expected.some((name, index) => columns[index] !== name)
        ) {
          throw new OperationalStorageVersionError(path);
        }
      }
    }
  } catch (cause) {
    if (sqliteBusyCauseSchema.safeParse(cause).success)
      throw new OperationalStoreBusyError(path, { cause });
    throw cause;
  } finally {
    database.close();
  }
}

const createSchema = (allowMemoryJournal: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const lockRows = yield* sql.unsafe("PRAGMA locking_mode = EXCLUSIVE");
    storedModeRow.parse(lockRows[0]);
    const journalRows = yield* sql.unsafe("PRAGMA journal_mode = WAL");
    const journalMode = storedJournalModeRow.parse(journalRows[0]).journal_mode;
    if (
      journalMode !== "wal" &&
      !(allowMemoryJournal && journalMode === "memory")
    ) {
      throw new Error(`Could not enable SQLite WAL mode: ${journalMode}`);
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // Set identifiers in the same transaction as the first schema creation.
        yield* sql.unsafe(`PRAGMA application_id = ${APPLICATION_ID}`);
        yield* sql.unsafe(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        yield* sql.unsafe(
          "CREATE TABLE IF NOT EXISTS operational_runs (work_id TEXT NOT NULL, run_id TEXT PRIMARY KEY, workflow_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, output_json TEXT, error_json TEXT, inspection_complete INTEGER NOT NULL DEFAULT 0 CHECK (inspection_complete IN (0, 1)), storage_error_json TEXT, next_sequence INTEGER NOT NULL DEFAULT 0 CHECK (next_sequence >= 0))",
        );
        yield* sql.unsafe(
          "CREATE TABLE IF NOT EXISTS operational_events (run_id TEXT NOT NULL REFERENCES operational_runs(run_id) ON DELETE CASCADE, sequence INTEGER NOT NULL CHECK (sequence > 0), event_json TEXT NOT NULL, byte_count INTEGER NOT NULL CHECK (byte_count >= 0), PRIMARY KEY (run_id, sequence))",
        );
        yield* sql.unsafe(
          "CREATE TABLE IF NOT EXISTS operational_traces (run_id TEXT PRIMARY KEY REFERENCES operational_runs(run_id) ON DELETE CASCADE, trace_id TEXT, spans_json TEXT NOT NULL, dropped_records INTEGER NOT NULL CHECK (dropped_records >= 0))",
        );
        yield* sql.unsafe(
          "CREATE INDEX IF NOT EXISTS operational_runs_created ON operational_runs(created_at DESC, run_id DESC)",
        );
      }),
    );
  });

function jsonText(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Operational history value must be JSON serializable");
  return encoded;
}

function parseStoredJson(text: string | null): JsonValue | undefined {
  if (text === null) return undefined;
  const parsed: unknown = JSON.parse(text);
  return jsonValueSchema.parse(parsed);
}

function parseStoredError(text: string | null) {
  if (text === null) return undefined;
  const parsed: unknown = JSON.parse(text);
  return serializedSeqlaneErrorSchema.parse(parsed);
}

function parseStoredRun(value: unknown): OperationalRunStatus {
  const row = storedRunRow.parse(value);
  const output = parseStoredJson(row.output_json);
  const error = parseStoredError(row.error_json);
  const storageError = parseStoredError(row.storage_error_json);
  return operationalRunStatusSchema.parse({
    version: 1,
    workId: row.work_id,
    runId: row.run_id,
    workflowKey: row.workflow_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
    completeness: operationalRunCompletenessSchema.parse({
      inspection: row.inspection_complete === 1 ? "complete" : "incomplete",
      ...(storageError === undefined ? {} : { storageError }),
    }),
  });
}

function asSerializedError(cause: unknown) {
  const serialized = serializedSeqlaneErrorSchema.safeParse(cause);
  return serialized.success
    ? serialized.data
    : serializedSeqlaneErrorSchema.parse(serializeSeqlaneError(cause));
}

export class OperationalStoreService extends Context.Service<
  OperationalStoreService,
  OperationalStore
>()("seqlane/OperationalStore") {}

/** The caller's scope owns the SQL connection, including failed startup. */
export function openOperationalStore(
  storageUrl?: string,
): Effect.Effect<OperationalStore, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const path = storagePath(storageUrl);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    preflightDatabase(path);
    let healthy = false;
    let closed = false;
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Effect.sync(() => {
        healthy = false;
        closed = true;
      }).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
    );
    const sql = yield* Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(
        SqliteClient.layer({ filename: path, busyTimeout: BUSY_TIMEOUT_MS }),
        scope,
      );
      const sql = Context.get(context, SqlClient);
      yield* createSchema(path === ":memory:").pipe(
        Effect.provideService(SqlClient, sql),
      );
      // Recovery follows exclusive ownership; it never replays unfinished work.
      const recoveredAt = new Date(
        yield* Effect.clockWith((clock) => clock.currentTimeMillis),
      ).toISOString();
      yield* sql.withTransaction(
        sql`UPDATE operational_runs SET status = 'interrupted', inspection_complete = 0, updated_at = ${recoveredAt} WHERE status IN ('queued', 'running')`,
      );
      return sql;
    }).pipe(
      Effect.catchCause((cause) => {
        const failure = Cause.squash(cause);
        return Scope.close(scope, Exit.fail(failure)).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.andThen(
            Effect.fail(
              sqliteBusyCauseSchema.safeParse(failure).success
                ? new OperationalStoreBusyError(path, { cause: failure })
                : failure instanceof OperationalStorageError
                  ? failure
                  : new OperationalStorageError("open", failure),
            ),
          ),
        );
      }),
    );
    healthy = true;

    const run = <A, E>(
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, unknown> =>
      effect.pipe(
        Effect.catchCause((failure) => {
          if (Cause.hasInterruptsOnly(failure))
            return Effect.failCause(failure);
          const cause = Cause.squash(failure);
          if (sqliteUniqueCauseSchema.safeParse(cause).success)
            return Effect.fail(cause);
          healthy = false;
          return Effect.fail(
            cause instanceof OperationalStorageError
              ? cause
              : sqliteBusyCauseSchema.safeParse(cause).success
                ? new OperationalStoreBusyError(path, { cause })
                : new OperationalStorageError("query", cause),
          );
        }),
      );
    const runForRunId = (runId: string) =>
      sql`SELECT work_id, run_id, workflow_key, status, created_at, updated_at, output_json, error_json, inspection_complete, storage_error_json FROM operational_runs WHERE run_id = ${runId}`;

    return {
      get healthy() {
        return healthy && !closed;
      },
      createRun: ({ workId, runId, workflowKey, createdAt }) =>
        run(
          sql`INSERT INTO operational_runs (work_id, run_id, workflow_key, status, created_at, updated_at) VALUES (${workId}, ${runId}, ${workflowKey}, 'queued', ${createdAt}, ${createdAt})`,
        ).pipe(
          Effect.asVoid,
          Effect.catch((cause) =>
            Effect.fail(
              sqliteUniqueCauseSchema.safeParse(cause).success
                ? new OperationalRunConflictError(runId, cause)
                : cause,
            ),
          ),
        ),
      setRunning: (runId, updatedAt) =>
        run(
          sql`UPDATE operational_runs SET status = 'running', updated_at = ${updatedAt} WHERE run_id = ${runId} AND status = 'queued'`,
        ).pipe(Effect.asVoid),
      appendEvent: (runId, rawEvent) =>
        run(
          Effect.gen(function* () {
            const event = seqlaneExecutionEventSchema.parse(rawEvent);
            if (event.runId !== runId)
              throw new TypeError(
                "Event run identity does not match stored run",
              );
            const eventJson = jsonText(event);
            const bytes = Buffer.byteLength(eventJson, "utf8");
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const rows =
                  yield* sql`SELECT work_id, next_sequence FROM operational_runs WHERE run_id = ${runId}`;
                const runRow = z
                  .strictObject({
                    work_id: z.string(),
                    next_sequence: z.number().int().nonnegative(),
                  })
                  .parse(rows[0]);
                if (event.workId !== runRow.work_id)
                  throw new TypeError(
                    "Event work identity does not match stored run",
                  );
                const expected = runRow.next_sequence + 1;
                if (event.metadata.sequence !== expected)
                  throw new TypeError(
                    "Hosted event sequence is not contiguous",
                  );
                yield* sql`INSERT INTO operational_events (run_id, sequence, event_json, byte_count) VALUES (${runId}, ${event.metadata.sequence}, ${eventJson}, ${bytes})`;
                yield* sql`UPDATE operational_runs SET next_sequence = ${event.metadata.sequence}, updated_at = ${event.metadata.occurredAt} WHERE run_id = ${runId}`;
              }),
            );
          }),
        ),
      completeRun: (input) =>
        run(
          Effect.gen(function* () {
            const spans = z
              .array(telemetrySpanSnapshotSchema)
              .max(2000)
              .parse(input.spans);
            const traceId = spans[0]?.traceId;
            const storageError =
              input.droppedRecords === 0
                ? undefined
                : asSerializedError(
                    new Error("Trace record retention limit reached"),
                  );
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE operational_runs SET status = ${input.status}, updated_at = ${input.updatedAt}, output_json = ${input.output === undefined ? null : jsonText(jsonValueSchema.parse(input.output))}, error_json = ${input.error === undefined ? null : jsonText(asSerializedError(input.error))}, inspection_complete = ${storageError === undefined ? 1 : 0}, storage_error_json = ${storageError === undefined ? null : jsonText(storageError)} WHERE run_id = ${input.runId}`;
                yield* sql`INSERT INTO operational_traces (run_id, trace_id, spans_json, dropped_records) VALUES (${input.runId}, ${traceId ?? null}, ${jsonText(spans)}, ${input.droppedRecords}) ON CONFLICT(run_id) DO UPDATE SET trace_id = excluded.trace_id, spans_json = excluded.spans_json, dropped_records = excluded.dropped_records`;
              }),
            );
          }),
        ),
      markIncomplete: (input) =>
        run(
          Effect.gen(function* () {
            const storageError = asSerializedError(input.storageError);
            const error =
              input.error === undefined
                ? null
                : jsonText(asSerializedError(input.error));
            const output =
              input.output === undefined
                ? null
                : jsonText(jsonValueSchema.parse(input.output));
            const spans =
              input.spans === undefined
                ? undefined
                : z
                    .array(telemetrySpanSnapshotSchema)
                    .max(2000)
                    .parse(input.spans);
            const droppedRecords = input.droppedRecords ?? 0;
            if (!Number.isSafeInteger(droppedRecords) || droppedRecords < 0)
              throw new TypeError(
                "Dropped trace record count must be a non-negative safe integer",
              );
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE operational_runs SET status = ${input.status}, updated_at = ${input.updatedAt}, output_json = ${output}, error_json = ${error}, inspection_complete = 0, storage_error_json = ${jsonText(storageError)} WHERE run_id = ${input.runId}`;
                if (spans !== undefined) {
                  const traceId = spans[0]?.traceId;
                  yield* sql`INSERT INTO operational_traces (run_id, trace_id, spans_json, dropped_records) VALUES (${input.runId}, ${traceId ?? null}, ${jsonText(spans)}, ${droppedRecords}) ON CONFLICT(run_id) DO UPDATE SET trace_id = excluded.trace_id, spans_json = excluded.spans_json, dropped_records = excluded.dropped_records`;
                }
              }),
            );
          }),
        ),
      status: (runId) =>
        run(
          Effect.gen(function* () {
            const rows = yield* runForRunId(runId);
            return rows.length === 0 ? undefined : parseStoredRun(rows[0]);
          }),
        ),
      list: (options) =>
        run(
          Effect.gen(function* () {
            const rows =
              options.cursor === undefined
                ? yield* sql`SELECT rowid, work_id, run_id, workflow_key, status, created_at, updated_at FROM operational_runs ORDER BY rowid DESC LIMIT ${options.limit + 1}`
                : yield* sql`SELECT rowid, work_id, run_id, workflow_key, status, created_at, updated_at FROM operational_runs WHERE rowid < ${options.cursor} ORDER BY rowid DESC LIMIT ${options.limit + 1}`;
            const parsed = rows
              .slice(0, options.limit)
              .map((value) => storedSummaryRow.parse(value));
            const summaries = parsed.map((row) =>
              operationalRunSummarySchema.parse({
                workId: row.work_id,
                runId: row.run_id,
                workflowKey: row.workflow_key,
                status: row.status,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
              }),
            );
            const nextCursor =
              rows.length > options.limit ? parsed.at(-1)?.rowid : undefined;
            return operationalRunListSchema.parse({
              version: 1,
              runs: summaries,
              ...(nextCursor === undefined ? {} : { nextCursor }),
            });
          }),
        ),
      events: (runId, options) =>
        run(
          Effect.gen(function* () {
            const snapshot = yield* sql.withTransaction(
              Effect.gen(function* () {
                const runRows = yield* runForRunId(runId);
                if (runRows.length === 0) return undefined;
                const sequenceRows =
                  yield* sql`SELECT next_sequence FROM operational_runs WHERE run_id = ${runId}`;
                const latest = storedSequenceRow.parse(
                  sequenceRows[0],
                ).next_sequence;
                const boundedLimit = Math.min(
                  options.limit,
                  MAX_EVENT_PAGE_COUNT,
                );
                const items: { sequence: number; event: unknown }[] = [];
                let cursor = options.afterSequence;
                let bytes = 0;
                let gap:
                  { fromSequence: number; toSequence: number } | undefined;
                while (items.length < boundedLimit) {
                  const rows =
                    yield* sql`SELECT sequence, byte_count, length(CAST(event_json AS BLOB)) AS actual_byte_count FROM operational_events WHERE run_id = ${runId} AND sequence > ${cursor} ORDER BY sequence ASC LIMIT 1`;
                  if (rows.length === 0) {
                    if (latest > cursor && gap === undefined)
                      gap = { fromSequence: cursor + 1, toSequence: latest };
                    break;
                  }
                  const row = storedEventSizeRow.parse(rows[0]);
                  if (row.byte_count !== row.actual_byte_count)
                    throw new TypeError("Stored event byte count is invalid");
                  if (row.sequence > cursor + 1) {
                    if (gap !== undefined) break;
                    gap = {
                      fromSequence: cursor + 1,
                      toSequence: row.sequence - 1,
                    };
                  }
                  if (bytes + row.byte_count > EVENT_PAGE_BYTES) {
                    if (items.length === 0)
                      throw new RangeError(
                        "A single stored event exceeds the inspection page byte limit",
                      );
                    break;
                  }
                  const eventRows =
                    yield* sql`SELECT event_json FROM operational_events WHERE run_id = ${runId} AND sequence = ${row.sequence}`;
                  const eventJson = z
                    .strictObject({ event_json: z.string() })
                    .parse(eventRows[0]).event_json;
                  if (
                    Buffer.byteLength(eventJson, "utf8") !==
                    row.actual_byte_count
                  )
                    throw new TypeError("Stored event byte count is invalid");
                  const eventValue: unknown = JSON.parse(eventJson);
                  const event = seqlaneExecutionEventSchema.parse(eventValue);
                  if (
                    event.runId !== runId ||
                    event.metadata.sequence !== row.sequence
                  )
                    throw new TypeError(
                      "Stored event identity or sequence is invalid",
                    );
                  bytes += row.byte_count;
                  items.push({ sequence: row.sequence, event });
                  cursor = row.sequence;
                  if (gap !== undefined) {
                    const nextRows =
                      yield* sql`SELECT sequence FROM operational_events WHERE run_id = ${runId} AND sequence > ${cursor} ORDER BY sequence ASC LIMIT 1`;
                    const nextRow =
                      nextRows[0] === undefined
                        ? undefined
                        : z
                            .strictObject({
                              sequence: z.number().int().nonnegative(),
                            })
                            .parse(nextRows[0]);
                    if (nextRow !== undefined && nextRow.sequence > cursor + 1)
                      break;
                  }
                }
                const terminalSizeRows =
                  yield* sql`SELECT sequence, byte_count, length(CAST(event_json AS BLOB)) AS actual_byte_count FROM operational_events WHERE run_id = ${runId} AND sequence = ${latest}`;
                const terminalSize =
                  terminalSizeRows[0] === undefined
                    ? undefined
                    : storedEventSizeRow.parse(terminalSizeRows[0]);
                if (
                  terminalSize !== undefined &&
                  terminalSize.byte_count !== terminalSize.actual_byte_count
                )
                  throw new TypeError(
                    "Stored terminal event byte count is invalid",
                  );
                const terminalWithinResponse =
                  terminalSize !== undefined &&
                  bytes + terminalSize.byte_count <= 31 * 1024 * 1024;
                const terminalRows = !terminalWithinResponse
                  ? []
                  : yield* sql`SELECT event_json FROM operational_events WHERE run_id = ${runId} AND sequence = ${latest}`;
                const terminalJson =
                  terminalRows[0] === undefined
                    ? undefined
                    : z
                        .strictObject({ event_json: z.string() })
                        .parse(terminalRows[0]).event_json;
                return { run: runRows[0], latest, items, gap, terminalJson };
              }),
            );
            if (snapshot === undefined) return undefined;
            const status = parseStoredRun(snapshot.run);
            const terminalValue: unknown =
              snapshot.terminalJson === undefined
                ? undefined
                : JSON.parse(snapshot.terminalJson);
            const terminal =
              terminalValue === undefined
                ? undefined
                : seqlaneExecutionEventSchema.parse(terminalValue);
            const terminalEvent =
              (status.status === "succeeded" &&
                terminal?.type === "run.succeeded") ||
              (status.status === "failed" && terminal?.type === "run.failed") ||
              (status.status === "cancelled" &&
                terminal?.type === "run.cancelled")
                ? terminal
                : undefined;
            return operationalRunEventsSchema.parse({
              version: 1,
              runId,
              afterSequence: options.afterSequence,
              events: snapshot.items,
              nextSequence:
                snapshot.items.at(-1)?.sequence ?? options.afterSequence,
              status: status.status,
              completeness:
                snapshot.gap === undefined
                  ? status.completeness
                  : {
                      inspection: "incomplete",
                      ...(status.completeness.storageError === undefined
                        ? {}
                        : { storageError: status.completeness.storageError }),
                    },
              ...(snapshot.gap === undefined ? {} : { gap: snapshot.gap }),
              ...(terminalEvent === undefined ? {} : { terminalEvent }),
            });
          }),
        ),
      trace: (runId) =>
        run(
          Effect.gen(function* () {
            const snapshot = yield* sql.withTransaction(
              Effect.gen(function* () {
                const runRows = yield* runForRunId(runId);
                if (runRows.length === 0) return undefined;
                const traceRows =
                  yield* sql`SELECT trace_id, spans_json, dropped_records FROM operational_traces WHERE run_id = ${runId}`;
                return { run: runRows[0], trace: traceRows[0] };
              }),
            );
            if (snapshot === undefined) return undefined;
            const status = parseStoredRun(snapshot.run);
            if (snapshot.trace === undefined)
              return operationalTraceInspectionSchema.parse({
                version: 1,
                runId,
                spans: [],
                completeness: status.completeness,
              });
            const row = storedTraceRow.parse(snapshot.trace);
            const spansValue: unknown = JSON.parse(row.spans_json);
            return operationalTraceInspectionSchema.parse({
              version: 1,
              runId,
              ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
              spans: spansValue,
              droppedRecords: row.dropped_records,
              completeness: status.completeness,
            });
          }),
        ),
      close: () =>
        Effect.suspend(() => {
          if (closed) return Effect.void;
          closed = true;
          healthy = false;
          return Scope.close(scope, Exit.void);
        }),
    };
  });
}
