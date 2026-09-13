import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROBE_OUTPUT_SCHEMA } from "./codex-app-server-probe-constants.mjs";
import {
  approvalRequestFor,
  assertProbeOutput,
  completedTurn,
  completedTurnStatus,
  compactEvents,
  defaultModel,
  findAgentMessage,
  parseInitializeResult,
  parseModelListResult,
  parseThreadResult,
  parseTurnResult,
  readCodexVersion,
  versionDiagnostic,
  observedRequestShape,
} from "./codex-app-server-probe-protocol.mjs";
import {
  AppServerClient,
  spawnCodexAppServer,
} from "./codex-app-server-probe-transport.mjs";

async function createProbeWorkspace(workspace) {
  if (workspace !== undefined)
    return { path: workspace, cleanup: async () => undefined };
  const path = await mkdtemp(join(tmpdir(), "seqlane-codex-probe-"));
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

async function readDetectedVersion(options, workspace) {
  try {
    return options.readVersion === undefined
      ? await readCodexVersion(options.executable, workspace)
      : await options.readVersion(options.executable, workspace);
  } catch {
    return undefined;
  }
}

function requireDistinctThread(sourceThreadId, forkedThreadId) {
  if (sourceThreadId === forkedThreadId)
    throw new Error("thread/fork returned the source thread");
  return forkedThreadId;
}

export async function runProbe(options) {
  const preparedWorkspace = await createProbeWorkspace(options.workspace);
  let client;
  try {
    const detectedVersion = await readDetectedVersion(
      options,
      preparedWorkspace.path,
    );
    const version = detectedVersion ?? "unknown";
    const diagnostic = versionDiagnostic(detectedVersion);
    if (diagnostic !== undefined)
      console.error(`warning: ${diagnostic.message}`);

    client = spawnCodexAppServer(
      options.executable,
      preparedWorkspace.path,
      options.spawnProcess,
    );
    const initializeResponse = await client.request(
      "initialize",
      {
        clientInfo: {
          name: "seqlane-protocol-probe",
          title: "Seqlane protocol probe",
          version: "0.0.0",
        },
      },
      options.timeoutMs,
    );
    const initialize = parseInitializeResult(initializeResponse);
    client.notify("initialized", {});

    const modelListResponse = await client.request(
      "model/list",
      {},
      options.timeoutMs,
    );
    const models = parseModelListResult(modelListResponse);
    const model = defaultModel(models);
    const threadId = parseThreadResult(
      await client.request(
        "thread/start",
        {
          cwd: preparedWorkspace.path,
          model,
          approvalPolicy: "never",
          sandbox: "read-only",
        },
        options.timeoutMs,
      ),
    ).thread.id;

    const turnStart = await client.request(
      "turn/start",
      {
        threadId,
        input: [
          {
            type: "text",
            text: 'Return exactly {"ok":true,"version":"probe"}. Do not call tools.',
          },
        ],
        cwd: preparedWorkspace.path,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
        outputSchema: PROBE_OUTPUT_SCHEMA,
        model,
      },
      options.timeoutMs,
    );
    const turnId = parseTurnResult(turnStart, "turn/start").turn.id;
    const completed = await client.waitFor(
      (message) => completedTurn(message, threadId, turnId),
      options.timeoutMs,
      "structured turn completion",
    );
    const completedTurnResult = completedTurnStatus(
      completed,
      threadId,
      turnId,
      "structured turn completion",
      "completed",
    );
    const outputText = findAgentMessage(
      client.requiredOutput,
      threadId,
      turnId,
    );
    let output;
    try {
      output = JSON.parse(outputText);
    } catch (cause) {
      throw new Error("structured turn output was not JSON", { cause });
    }
    assertProbeOutput(output);

    const forkResult = await client.request(
      "thread/fork",
      { threadId, lastTurnId: turnId },
      options.timeoutMs,
    );
    const forkedThreadId = parseThreadResult(forkResult, "thread/fork").thread
      .id;
    requireDistinctThread(threadId, forkedThreadId);

    const interruptThreadId = parseThreadResult(
      await client.request(
        "thread/start",
        {
          cwd: preparedWorkspace.path,
          model,
          approvalPolicy: "on-request",
          sandbox: "read-only",
        },
        options.timeoutMs,
      ),
    ).thread.id;
    const interruptStart = await client.request(
      "turn/start",
      {
        threadId: interruptThreadId,
        input: [
          {
            type: "text",
            text: "Create a file named protocol-probe-must-not-exist.txt in the workspace.",
          },
        ],
        cwd: preparedWorkspace.path,
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly" },
        outputSchema: { type: "string" },
        model,
      },
      options.timeoutMs,
    );
    const interruptTurnId = parseTurnResult(interruptStart, "turn/start").turn
      .id;
    const approvalRequest = await client.waitFor(
      (message) =>
        approvalRequestFor(message, interruptThreadId, interruptTurnId),
      options.timeoutMs,
      "approval request",
    );
    await client.request(
      "turn/interrupt",
      { threadId: interruptThreadId, turnId: interruptTurnId },
      options.timeoutMs,
    );
    const interrupted = await client.waitFor(
      (message) => completedTurn(message, interruptThreadId, interruptTurnId),
      options.timeoutMs,
      "interrupt completion",
    );
    const interruptedTurn = completedTurnStatus(
      interrupted,
      interruptThreadId,
      interruptTurnId,
      "interrupt completion",
    );

    return {
      protocol: "codex-app-server",
      version,
      generatedBy: "seqlane-protocol-probe",
      ...(diagnostic === undefined ? {} : { diagnostic }),
      initialize: {
        responseKeys: Object.keys(initializeResponse).sort(),
        userAgent: initialize.userAgent,
        platformFamily: initialize.platformFamily,
        platformOs: initialize.platformOs,
      },
      modelList: {
        responseKeys: Object.keys(modelListResponse).sort(),
        defaultModel: model,
        models,
      },
      structuredOutput: {
        request: { method: "turn/start", outputSchema: PROBE_OUTPUT_SCHEMA },
        eventMethods: compactEvents(client.transcript, threadId, turnId),
        terminalStatus: completedTurnResult.turn.status,
        output,
      },
      fork: {
        request: observedRequestShape(client.transcript, "thread/fork"),
        responseKeys: Object.keys(forkResult).sort(),
        returnedThread: "<forked-thread-id>",
      },
      interrupt: {
        request: observedRequestShape(client.transcript, "turn/interrupt"),
        terminalStatus: interruptedTurn.turn.status,
      },
      approval: {
        requestMethod: approvalRequest.method,
        decisionResponseSent: false,
        interruptedWithoutDecision:
          interruptedTurn.turn.status === "interrupted",
      },
    };
  } finally {
    await client?.close().catch(() => undefined);
    await preparedWorkspace.cleanup();
  }
}

export { AppServerClient, requireDistinctThread };
