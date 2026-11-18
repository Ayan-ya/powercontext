import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PowerContextClient } from "../src/powercontext-client.mjs";

test("PowerContext client writes and prepares task state", async (context) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ path: request.url, authorization: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/memory/remember") {
      response.end(JSON.stringify({ records: [{ id: "memory-1" }] }));
    } else {
      response.end(JSON.stringify({ status: "ready", content: "task_id SDD-REL-001" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const client = new PowerContextClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "test-token",
  });
  const saved = await client.saveTaskState("scope-1", {
    taskId: "SDD-REL-001",
    status: "verified",
    completed: ["tests"],
    todo: [],
    verification: ["6 passed"],
  });
  const prepared = await client.prepareTaskState("scope-1", "SDD-REL-001");

  assert.equal(saved.records.length, 1);
  assert.equal(prepared.status, "ready");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].authorization, "Bearer test-token");
  assert.equal(requests[0].body.kind, "decision");
  assert.match(requests[0].body.text, /status verified/);
  assert.equal(requests[1].body.scope_id, "scope-1");
  assert.match(requests[1].body.query, /task_id SDD-REL-001/);
});
