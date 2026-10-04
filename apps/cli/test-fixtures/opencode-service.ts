/** Native executable fixture used only by compiled CLI integration tests. */
export const openCodeServiceFixture = String.raw`#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
const marker = process.env.SEQLANE_TEST_SERVICE_MARKER;
const mode = process.env.SEQLANE_TEST_SERVICE_MODE;
const authorization = "Basic " + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ":" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
const providers = [{ id: "openai", models: { "gpt-5.6-luna": { id: "gpt-5.6-luna" } } }];
const pending = [];
const json = (response, value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
const message = (error) => ({ info: { id: "message-1", sessionID: "session-1", role: "assistant", time: { created: 1, completed: 2 }, parentID: "message-0", modelID: "gpt-5.6-luna", providerID: "openai", mode: "build", agent: "build", path: { cwd: process.cwd(), root: process.cwd() }, cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, ...(error ? { error } : { structured: { answer: "fixture answer" } }) }, parts: error ? [] : [{ id: "part-1", sessionID: "session-1", messageID: "message-1", type: "text", text: JSON.stringify({ answer: "fixture answer" }) }] });
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== authorization) { appendFileSync(marker, "unauthorized " + request.url + "\n"); response.writeHead(401); response.end(); return; }
  const path = new URL(request.url, "http://localhost").pathname;
  appendFileSync(marker, path + "\n");
  for await (const chunk of request) void chunk;
  if (path === "/global/health") return json(response, { healthy: true, version: "1.18.27" });
  if (path === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end(); return; }
  if (path === "/provider") return json(response, { all: providers, default: { openai: "gpt-5.6-luna" }, connected: ["openai"] });
  if (path === "/config/providers") return json(response, { providers, default: { openai: "gpt-5.6-luna" } });
  if (path === "/session" && request.method === "POST") return json(response, { id: "session-1", projectID: "project-1", directory: process.cwd(), title: "fixture", version: "1", time: { created: 1, updated: 1 } });
  if (path === "/session/session-1/message" && request.method === "POST") {
    if (mode === "hold") { pending.push(response); return; }
    return json(response, message(mode === "interaction" ? { name: "PermissionRequired", data: { prompt: "approval" } } : undefined));
  }
  if (path === "/session/session-1/abort") { for (const item of pending.splice(0)) json(item, message({ name: "MessageAbortedError", data: { message: "aborted" } })); return json(response, true); }
  if (path === "/event") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": connected\n\n"); return; }
  if (/^\/api\/session\/[^/]+\/(permission|question|history)$/.test(path)) return json(response, { data: [], hasMore: false });
  if (path === "/session/session-1/message") return json(response, { data: [] });
  if (path === "/permission") return json(response, []);
  response.writeHead(404); response.end();
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(marker, "started pid=" + process.pid + "\n");
  console.log("opencode server listening on http://127.0.0.1:" + server.address().port);
});
process.on("SIGTERM", () => { appendFileSync(marker, "closed\n"); server.closeAllConnections(); server.close(() => process.exit(0)); });
`;
